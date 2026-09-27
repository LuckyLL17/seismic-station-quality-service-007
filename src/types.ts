export type StationStatus = 'online' | 'maintenance' | 'offline';
/** 状态变更来源：manual=值守人员人工变更；observation=观测到达触发的事件性变更 */
export type StatusSource = 'manual' | 'observation';

export type Station = {
  id: string;
  code: string;
  name: string;
  region: string;
  elevationM: number;
  status: StationStatus;
  lastSeenAt: string;
  updatedAt: string;
  updatedBy?: string;
};

export type StatusEvent = {
  id: string;
  stationId: string;
  /** 建档时为 null，其余为变更前状态 */
  fromStatus: StationStatus | null;
  toStatus: StationStatus;
  source: StatusSource;
  reason?: string;
  changedAt: string;
};

export type Observation = {
  id: string;
  stationId: string;
  observedAt: string;
  samples: number;
  sampleRateHz: number;
  peakAmplitude: number;
  timingOffsetMs: number;
  qualityScore: number;
  /** 数据本身的质量问题（采样不足、削顶、时间偏差），参与扣分 */
  issues: string[];
  /** 接入上下文标记（如维护期观测、自动恢复上线），不参与扣分，供质量报告区分 */
  flags: string[];
};

/** 台站档案快照：报告生成时固化，后续资料更新不会改写历史报告 */
export type StationSnapshot = {
  stationId: string;
  code: string;
  name: string;
  region: string;
  elevationM: number;
};

export type QualityReport = {
  id: string;
  stationId: string;
  stationSnapshot: StationSnapshot;
  statusAtGeneration: StationStatus;
  windowStart: string;
  windowEnd: string;
  observationCount: number;
  /** 窗口内维护期接入的观测条数 */
  maintenanceObservationCount: number;
  /** 窗口内由观测事件触发自动上线的观测条数 */
  autoOnlineObservationCount: number;
  averageScore: number;
  issues: string[];
  flags: string[];
  generatedAt: string;
};
