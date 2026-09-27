import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { createReport, observations, recordStatusEvent, reports, stations, statusEvents, updateStationProfile } from './store.js';
import { canManualTransition, isStationStatus, OBSERVATION_FLAG_AUTO_ONLINE, OBSERVATION_FLAG_MAINTENANCE, resolveObservationStatus } from './status.js';
import type { Station, StationStatus } from './types.js';

const ingestSchema = z.object({ stationId: z.string(), observedAt: z.string().datetime().optional(), samples: z.number().int().nonnegative(), sampleRateHz: z.number().positive(), peakAmplitude: z.number().nonnegative(), timingOffsetMs: z.number() });
const reportSchema = z.object({ stationId: z.string(), windowStart: z.string().datetime(), windowEnd: z.string().datetime() });

/** 台站资料更新：档案字段可选，status 为人工状态变更；拒绝未知字段 */
const stationUpdateSchema = z
  .object({
    name: z.string().trim().min(1).optional(),
    region: z.string().trim().min(1).optional(),
    elevationM: z.number().finite().optional(),
    status: z.string().optional(),
    reason: z.string().trim().min(1).optional(),
    updatedBy: z.string().trim().min(1).optional()
  })
  .strict()
  .refine(data => Object.keys(data).length > 0, { message: '请求体不能为空，至少提供一项待更新字段' });

const stationCreateSchema = z
  .object({
    code: z.string().trim().min(1).optional(),
    name: z.string().trim().min(1).optional(),
    region: z.string().trim().min(1).optional(),
    elevationM: z.number().finite().optional(),
    status: z.string().optional(),
    reason: z.string().trim().min(1).optional(),
    updatedBy: z.string().trim().min(1).optional()
  })
  .strict();

export async function registerRoutes(app: FastifyInstance) {
  app.get('/health', async () => ({ status: 'ok', service: 'seismic-station-quality-service', workflow: '台站档案维护 → 接收台站数据 → 检测完整性 → 计算质量分 → 生成质量报告' }));

  // ---------- 台站档案 ----------
  app.get('/api/stations', async () => stations);

  app.get('/api/stations/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const station = stations.find(item => item.id === id);
    if (!station) return reply.code(404).send({ error: '台站不存在' });
    return station;
  });

  app.post('/api/stations', async (request, reply) => {
    const parsed = stationCreateSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: '参数校验失败', details: parsed.error.flatten() });
    const body = parsed.data;
    if (body.status !== undefined && !isStationStatus(body.status)) {
      return reply.code(400).send({ error: `status 仅支持 online / maintenance / offline，收到：${body.status}` });
    }
    const ts = new Date().toISOString();
    const station: Station = {
      id: randomUUID(),
      code: body.code ?? `QZ-${String(stations.length + 1).padStart(3, '0')}`,
      name: body.name ?? '未命名台站',
      region: body.region ?? '未设置',
      elevationM: body.elevationM ?? 0,
      status: (body.status as StationStatus) ?? 'offline',
      lastSeenAt: ts,
      updatedAt: ts,
      ...(body.updatedBy ? { updatedBy: body.updatedBy } : {})
    };
    if (stations.some(item => item.code === station.code)) {
      return reply.code(409).send({ error: `台站编码已存在：${station.code}` });
    }
    stations.push(station);
    // 建档同样留痕，便于状态历史从建台开始完整可追溯
    const event = recordStatusEvent(station, station.status, 'manual', body.reason ?? '台站建档', ts, null);
    return reply.code(201).send({ station, statusEvent: event });
  });

  /**
   * 台站资料更新（值守人员发现档案错误时的唯一人工入口）
   * - 名称/区域/海拔：直接修订档案
   * - status：人工状态变更，走维护/离线/在线互转规则，非法转换拒绝并留痕说明
   * 人工变更与观测事件完全分离：本接口写入的状态事件 source 恒为 manual。
   */
  app.patch('/api/stations/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const station = stations.find(item => item.id === id);
    if (!station) return reply.code(404).send({ error: '台站不存在' });

    const parsed = stationUpdateSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: '参数校验失败', details: parsed.error.flatten() });
    const patch = parsed.data;

    if (patch.status !== undefined && !isStationStatus(patch.status)) {
      return reply.code(400).send({ error: `status 仅支持 online / maintenance / offline，收到：${patch.status}` });
    }

    const ts = new Date().toISOString();
    const profileChanged = patch.name !== undefined || patch.region !== undefined || patch.elevationM !== undefined || patch.updatedBy !== undefined;
    if (profileChanged) updateStationProfile(station, patch, ts);

    let statusEvent: (typeof statusEvents)[number] | undefined;
    const wantStatus = patch.status as StationStatus | undefined;
    if (wantStatus !== undefined) {
      if (!canManualTransition(station.status, wantStatus)) {
        return reply.code(409).send({ error: `不允许的人工状态转换：${station.status} → ${wantStatus}` });
      }
      if (wantStatus !== station.status) {
        const from = station.status;
        station.status = wantStatus;
        station.updatedAt = ts;
        if (patch.updatedBy !== undefined) station.updatedBy = patch.updatedBy;
        statusEvent = recordStatusEvent(station, wantStatus, 'manual', patch.reason, ts, from);
      }
    }

    return reply.send({ station, ...(statusEvent ? { statusEvent } : {}) });
  });

  // ---------- 状态变更审计 ----------
  /** 查询状态变更流水，可按台站、来源（manual/observation）过滤 */
  app.get('/api/status-events', async (request) => {
    const query = request.query as { stationId?: string; source?: string };
    return statusEvents
      .filter(item => !query.stationId || item.stationId === query.stationId)
      .filter(item => !query.source || item.source === query.source)
      .sort((a, b) => a.changedAt.localeCompare(b.changedAt));
  });

  // ---------- 观测接入 ----------
  app.post('/api/observations/ingest', async (request, reply) => {
    const parsed = ingestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: '参数校验失败', details: parsed.error.flatten() });
    const input = parsed.data;
    const station = stations.find(item => item.id === input.stationId);
    if (!station) return reply.code(404).send({ error: '台站不存在' });

    // 质量问题：数据本身缺陷，参与扣分
    const issues: string[] = [];
    if (input.samples < input.sampleRateHz * 30) issues.push('采样窗口不足');
    if (input.peakAmplitude > 0.95) issues.push('波形削顶风险');
    if (Math.abs(input.timingOffsetMs) > 5) issues.push('时间同步偏差');
    const qualityScore = Math.max(0, Math.round(100 - issues.length * 22 - Math.min(Math.abs(input.timingOffsetMs), 20)));

    // 接入上下文标记：与质量问题分离，不参与扣分
    const flags: string[] = [];
    const previousStatus = station.status;
    const result = resolveObservationStatus(previousStatus);
    if (previousStatus === 'maintenance') flags.push(OBSERVATION_FLAG_MAINTENANCE);
    if (result.transitionedToOnline) flags.push(OBSERVATION_FLAG_AUTO_ONLINE);

    const observedAt = input.observedAt ?? new Date().toISOString();
    const observation = { id: randomUUID(), ...input, observedAt, qualityScore, issues, flags };
    observations.push(observation);

    station.lastSeenAt = observedAt;
    let statusEvent: (typeof statusEvents)[number] | undefined;
    if (result.transitionedToOnline) {
      // 观测事件自动恢复上线，来源标记为 observation，与人工操作可审计区分
      const changedAt = new Date().toISOString();
      station.status = 'online';
      station.updatedAt = changedAt;
      statusEvent = recordStatusEvent(station, 'online', 'observation', '观测数据到达，自动恢复在线', changedAt, previousStatus);
    }
    // maintenance 态：观测正常接入、lastSeenAt 照常更新，但状态被人工置位保护，不自动改变

    return reply.code(201).send({ observation, station, ...(statusEvent ? { statusEvent } : {}) });
  });

  app.get('/api/observations', async (request) => {
    const query = request.query as { stationId?: string; minScore?: string };
    return observations.filter(item => (!query.stationId || item.stationId === query.stationId) && (!query.minScore || item.qualityScore >= Number(query.minScore)));
  });

  // ---------- 质量报告 ----------
  app.post('/api/quality/reports/run', async (request, reply) => {
    const parsed = reportSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: '参数校验失败', details: parsed.error.flatten() });
    if (!stations.some(item => item.id === parsed.data.stationId)) return reply.code(404).send({ error: '台站不存在' });
    // 报告生成时固化台站档案快照与当前状态，后续改名/改区域不影响已生成报告
    return reply.code(201).send(createReport(parsed.data.stationId, parsed.data.windowStart, parsed.data.windowEnd));
  });

  app.get('/api/quality/reports', async (request) => {
    const query = request.query as { stationId?: string };
    return reports.filter(item => !query.stationId || item.stationId === query.stationId);
  });
}
