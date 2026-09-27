import type { StationStatus } from './types.js';

/**
 * 台站状态机
 *
 * 三个状态：
 * - online（在线）：正常运行并持续接入观测
 * - maintenance（维护）：值守人员因检修/校准等原因人工置位，期间观测仍可接入但不改变状态
 * - offline（离线）：未运行/未接入
 *
 * 两类转换来源，严格区分：
 * - 人工（manual）：值守人员通过 PATCH /api/stations/:id 主动置位，三个状态间可互转
 * - 观测事件（observation）：观测到达时按 resolveObservationStatus 推导，
 *   只允许 offline → online（数据到达说明台站已恢复），
 *   维护态必须由人工解除，观测事件不得覆盖维护置位。
 */
export const ALL_STATUSES: readonly StationStatus[] = ['online', 'maintenance', 'offline'];

export function isStationStatus(value: unknown): value is StationStatus {
  return typeof value === 'string' && (ALL_STATUSES as readonly string[]).includes(value);
}

const MANUAL_TRANSITIONS: Record<StationStatus, StationStatus[]> = {
  online: ['maintenance', 'offline'],
  maintenance: ['online', 'offline'],
  offline: ['online', 'maintenance'],
};

/** 人工状态变更是否合法（目标与当前相同视为空操作，调用方直接放行但不留审计） */
export function canManualTransition(from: StationStatus, to: StationStatus): boolean {
  return from === to || MANUAL_TRANSITIONS[from].includes(to);
}

export type ObservationStatusResult = {
  /** 观测接入后台站应处状态 */
  status: StationStatus;
  /** 是否由该观测触发了 offline → online 的自动转换 */
  transitionedToOnline: boolean;
};

/** 观测事件驱动的状态推导：维护态受保护，仅离线态可被观测自动拉起 */
export function resolveObservationStatus(current: StationStatus): ObservationStatusResult {
  if (current === 'maintenance') {
    return { status: 'maintenance', transitionedToOnline: false };
  }
  if (current === 'offline') {
    return { status: 'online', transitionedToOnline: true };
  }
  return { status: 'online', transitionedToOnline: false };
}

/** 观测接入时的上下文标记（不参与质量扣分） */
export const OBSERVATION_FLAG_MAINTENANCE = '维护期观测';
export const OBSERVATION_FLAG_AUTO_ONLINE = '观测触发自动上线';
