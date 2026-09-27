import { randomUUID } from 'node:crypto';
import type { Observation, QualityReport, Station, StationSnapshot, StatusEvent, StatusSource } from './types.js';

const now = () => new Date().toISOString();

export const stations: Station[] = [
  { id: 'st-001', code: 'QZ-A01', name: '青岚台站', region: '川西断裂带', elevationM: 1840, status: 'online', lastSeenAt: now(), updatedAt: now() },
  { id: 'st-002', code: 'QZ-B07', name: '白石台站', region: '龙门山南段', elevationM: 920, status: 'online', lastSeenAt: now(), updatedAt: now() },
  { id: 'st-003', code: 'QZ-C12', name: '岷江台站', region: '岷江河谷', elevationM: 2470, status: 'maintenance', lastSeenAt: now(), updatedAt: now() }
];
export const observations: Observation[] = [];
export const reports: QualityReport[] = [];
/** 台站状态变更流水（人工 + 观测事件），与台站档案分开持久化 */
export const statusEvents: StatusEvent[] = [
  { id: randomUUID(), stationId: 'st-001', fromStatus: null, toStatus: 'online', source: 'manual', changedAt: now() },
  { id: randomUUID(), stationId: 'st-002', fromStatus: null, toStatus: 'online', source: 'manual', changedAt: now() },
  { id: randomUUID(), stationId: 'st-003', fromStatus: 'online', toStatus: 'maintenance', source: 'manual', reason: '初始种子数据：设备检修', changedAt: now() }
];

/** 记录一次状态转换；fromStatus 省略时取台站当前状态（建档传 null） */
export function recordStatusEvent(
  station: Station,
  toStatus: StatusEvent['toStatus'],
  source: StatusSource,
  reason: string | undefined,
  changedAt: string,
  fromStatus?: StatusEvent['fromStatus']
): StatusEvent {
  const event: StatusEvent = {
    id: randomUUID(),
    stationId: station.id,
    fromStatus: fromStatus === undefined ? station.status : fromStatus,
    toStatus,
    source,
    ...(reason ? { reason } : {}),
    changedAt
  };
  statusEvents.push(event);
  return event;
}

/** 更新台站档案资料（名称/区域/海拔），统一维护 updatedAt */
export function updateStationProfile(
  station: Station,
  patch: { name?: string; region?: string; elevationM?: number; updatedBy?: string },
  changedAt: string = now()
): Station {
  if (patch.name !== undefined) station.name = patch.name;
  if (patch.region !== undefined) station.region = patch.region;
  if (patch.elevationM !== undefined) station.elevationM = patch.elevationM;
  station.updatedBy = patch.updatedBy;
  station.updatedAt = changedAt;
  return station;
}

export function stationSnapshot(station: Station): StationSnapshot {
  return { stationId: station.id, code: station.code, name: station.name, region: station.region, elevationM: station.elevationM };
}

export function createReport(stationId: string, start: string, end: string): QualityReport {
  const station = stations.find(item => item.id === stationId)!;
  const rows = observations.filter(item => item.stationId === stationId && item.observedAt >= start && item.observedAt <= end);
  const averageScore = rows.length ? Math.round(rows.reduce((sum, item) => sum + item.qualityScore, 0) / rows.length) : 0;
  const issues = [...new Set(rows.flatMap(item => item.issues))];
  const flags = [...new Set(rows.flatMap(item => item.flags))];
  const countWithFlag = (flag: string) => rows.filter(item => item.flags.includes(flag)).length;
  const report: QualityReport = {
    id: randomUUID(),
    stationId,
    stationSnapshot: stationSnapshot(station),
    statusAtGeneration: station.status,
    windowStart: start,
    windowEnd: end,
    observationCount: rows.length,
    maintenanceObservationCount: countWithFlag('维护期观测'),
    autoOnlineObservationCount: countWithFlag('观测触发自动上线'),
    averageScore,
    issues,
    flags,
    generatedAt: now()
  };
  reports.push(report);
  return report;
}
