export type StationStatus = 'online' | 'maintenance' | 'offline';
export type StationEventSource = 'manual' | 'observation';
export type Station = { id: string; code: string; name: string; region: string; elevationM: number; status: StationStatus; lastSeenAt: string };
/**
 * 台站状态事件：人工状态变更与观测事件统一留痕，通过 source 区分。
 * 建档时 fromStatus 为 null，其余事件均记录变更前后的状态。
 */
export type StationEvent = { id: string; stationId: string; source: StationEventSource; fromStatus: StationStatus | null; toStatus: StationStatus; operator: string | null; reason: string | null; observationId: string | null; createdAt: string };
export type Observation = { id: string; stationId: string; observedAt: string; samples: number; sampleRateHz: number; peakAmplitude: number; timingOffsetMs: number; qualityScore: number; issues: string[] };
/** stationStatus 为报告生成时的台站运行状态快照，保证报告与档案一致 */
export type QualityReport = { id: string; stationId: string; stationStatus: StationStatus; windowStart: string; windowEnd: string; observationCount: number; averageScore: number; issues: string[]; generatedAt: string };
