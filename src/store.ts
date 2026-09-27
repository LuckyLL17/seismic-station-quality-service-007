import { randomUUID } from 'node:crypto';
import type { Observation, QualityReport, Station, StationEvent, StationEventSource, StationStatus } from './types.js';

export const stations: Station[] = [
  { id: 'st-001', code: 'QZ-A01', name: '青岚台站', region: '川西断裂带', elevationM: 1840, status: 'online', lastSeenAt: new Date().toISOString() },
  { id: 'st-002', code: 'QZ-B07', name: '白石台站', region: '龙门山南段', elevationM: 920, status: 'online', lastSeenAt: new Date().toISOString() },
  { id: 'st-003', code: 'QZ-C12', name: '岷江台站', region: '岷江河谷', elevationM: 2470, status: 'maintenance', lastSeenAt: new Date().toISOString() }
];
export const observations: Observation[] = [];
export const reports: QualityReport[] = [];
export const stationEvents: StationEvent[] = [];

/**
 * 人工状态转换规则：
 * - online → maintenance：计划检修
 * - online → offline：停运下线
 * - maintenance → online：检修完成，恢复观测
 * - maintenance → offline：检修后停运
 * - offline → maintenance：重新启用须先进入维护检查，禁止离线直接上线
 * 观测事件不在此表中：观测到达不允许改变人工设定的状态。
 */
export const STATION_TRANSITIONS: Record<StationStatus, StationStatus[]> = {
  online: ['maintenance', 'offline'],
  maintenance: ['online', 'offline'],
  offline: ['maintenance']
};

export function canTransition(from: StationStatus, to: StationStatus): boolean {
  return STATION_TRANSITIONS[from].includes(to);
}

export function recordStationEvent(input: { stationId: string; source: StationEventSource; fromStatus: StationStatus | null; toStatus: StationStatus; operator?: string; reason?: string; observationId?: string }): StationEvent {
  const event: StationEvent = {
    id: randomUUID(),
    stationId: input.stationId,
    source: input.source,
    fromStatus: input.fromStatus,
    toStatus: input.toStatus,
    operator: input.operator ?? null,
    reason: input.reason ?? null,
    observationId: input.observationId ?? null,
    createdAt: new Date().toISOString()
  };
  stationEvents.push(event);
  return event;
}

export function createReport(stationId: string, start: string, end: string): QualityReport {
  const station = stations.find(item => item.id === stationId);
  const rows = observations.filter(item => item.stationId === stationId && item.observedAt >= start && item.observedAt <= end);
  const averageScore = rows.length ? Math.round(rows.reduce((sum, item) => sum + item.qualityScore, 0) / rows.length) : 0;
  const issues = [...new Set(rows.flatMap(item => item.issues))];
  const report = { id: randomUUID(), stationId, stationStatus: station ? station.status : 'offline', windowStart: start, windowEnd: end, observationCount: rows.length, averageScore, issues, generatedAt: new Date().toISOString() } as QualityReport;
  reports.push(report); return report;
}
