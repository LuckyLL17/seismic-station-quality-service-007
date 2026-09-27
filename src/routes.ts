import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { canTransition, createReport, observations, recordStationEvent, reports, stations, stationEvents, STATION_TRANSITIONS } from './store.js';
import type { Station } from './types.js';

const stationStatusSchema = z.enum(['online', 'maintenance', 'offline']);
const createStationSchema = z.object({ code: z.string().min(1).optional(), name: z.string().min(1).optional(), region: z.string().min(1).optional(), elevationM: z.number().optional(), status: stationStatusSchema.optional() });
const updateStationSchema = z.object({
  name: z.string().min(1).optional(),
  region: z.string().min(1).optional(),
  elevationM: z.number().optional(),
  status: stationStatusSchema.optional(),
  operator: z.string().min(1).optional(),
  reason: z.string().min(1).optional()
}).refine(data => data.name !== undefined || data.region !== undefined || data.elevationM !== undefined || data.status !== undefined, { message: '至少提供一个待更新字段' });
const ingestSchema = z.object({ stationId: z.string(), observedAt: z.string().datetime().optional(), samples: z.number().int().nonnegative(), sampleRateHz: z.number().positive(), peakAmplitude: z.number().nonnegative(), timingOffsetMs: z.number() });
const reportSchema = z.object({ stationId: z.string(), windowStart: z.string().datetime(), windowEnd: z.string().datetime() });

export async function registerRoutes(app: FastifyInstance) {
  app.get('/health', async () => ({ status: 'ok', service: 'seismic-station-quality-service', workflow: '维护台站档案 → 接收观测数据 → 检测完整性 → 计算质量分 → 生成质量报告' }));
  app.get('/api/stations', async () => stations);

  app.post('/api/stations', async (request, reply) => {
    const parsed = createStationSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: '参数校验失败', details: parsed.error.flatten() });
    const body = parsed.data;
    const station: Station = { id: randomUUID(), code: body.code ?? `QZ-${stations.length + 1}`, name: body.name ?? '未命名台站', region: body.region ?? '未设置', elevationM: body.elevationM ?? 0, status: body.status ?? 'offline', lastSeenAt: new Date().toISOString() };
    stations.push(station);
    recordStationEvent({ stationId: station.id, source: 'manual', fromStatus: null, toStatus: station.status, reason: '台站建档' });
    return reply.code(201).send(station);
  });

  // 台站资料更新：名称、区域、海拔直接更新；运行状态按状态机规则转换并留痕
  app.patch('/api/stations/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const station = stations.find(item => item.id === id);
    if (!station) return reply.code(404).send({ error: '台站不存在' });
    const parsed = updateStationSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: '参数校验失败', details: parsed.error.flatten() });
    const input = parsed.data;
    const statusChanging = input.status !== undefined && input.status !== station.status;
    if (statusChanging) {
      if (!input.reason) return reply.code(400).send({ error: '人工状态变更必须填写原因' });
      if (!canTransition(station.status, input.status!)) return reply.code(409).send({ error: `不允许从 ${station.status} 直接切换到 ${input.status}`, allowedTransitions: STATION_TRANSITIONS[station.status] });
    }
    if (input.name !== undefined) station.name = input.name;
    if (input.region !== undefined) station.region = input.region;
    if (input.elevationM !== undefined) station.elevationM = input.elevationM;
    let event = null;
    if (statusChanging) {
      event = recordStationEvent({ stationId: station.id, source: 'manual', fromStatus: station.status, toStatus: input.status!, operator: input.operator, reason: input.reason });
      station.status = input.status!;
    }
    return reply.send({ station, event });
  });

  // 台站状态事件查询：人工变更与观测事件统一审计
  app.get('/api/stations/:id/events', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!stations.some(item => item.id === id)) return reply.code(404).send({ error: '台站不存在' });
    return stationEvents.filter(item => item.stationId === id);
  });

  app.post('/api/observations/ingest', async (request, reply) => {
    const parsed = ingestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: '参数校验失败', details: parsed.error.flatten() });
    const input = parsed.data;
    const station = stations.find(item => item.id === input.stationId);
    if (!station) return reply.code(404).send({ error: '台站不存在' });
    const issues: string[] = [];
    if (input.samples < input.sampleRateHz * 30) issues.push('采样窗口不足');
    if (input.peakAmplitude > 0.95) issues.push('波形削顶风险');
    if (Math.abs(input.timingOffsetMs) > 5) issues.push('时间同步偏差');
    // 观测事件不改变人工设定的运行状态；非在线台站收到数据时打标并留痕
    if (station.status === 'maintenance') issues.push('维护期间收到观测数据');
    if (station.status === 'offline') issues.push('离线台站收到观测数据');
    const qualityScore = Math.max(0, Math.round(100 - issues.length * 22 - Math.min(Math.abs(input.timingOffsetMs), 20)));
    const observation = { id: randomUUID(), ...input, observedAt: input.observedAt ?? new Date().toISOString(), qualityScore, issues };
    observations.push(observation);
    station.lastSeenAt = observation.observedAt;
    if (station.status !== 'online') {
      recordStationEvent({ stationId: station.id, source: 'observation', fromStatus: station.status, toStatus: station.status, observationId: observation.id, reason: '非在线状态收到观测数据，运行状态保持不变' });
    }
    return reply.code(201).send(observation);
  });

  app.get('/api/observations', async (request) => { const query = request.query as { stationId?: string; minScore?: string }; return observations.filter(item => (!query.stationId || item.stationId === query.stationId) && (!query.minScore || item.qualityScore >= Number(query.minScore))); });
  app.post('/api/quality/reports/run', async (request, reply) => { const parsed = reportSchema.safeParse(request.body); if (!parsed.success) return reply.code(400).send({ error: '参数校验失败', details: parsed.error.flatten() }); if (!stations.some(item => item.id === parsed.data.stationId)) return reply.code(404).send({ error: '台站不存在' }); return reply.code(201).send(createReport(parsed.data.stationId, parsed.data.windowStart, parsed.data.windowEnd)); });
  app.get('/api/quality/reports', async (request) => { const query = request.query as { stationId?: string }; return reports.filter(item => !query.stationId || item.stationId === query.stationId); });
}
