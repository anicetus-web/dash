export const STAGES = [
  { index: 0, id: 'C78:PREPARATION', name: 'Взят в работу', role: 'preparation' },
  { index: 1, id: 'C78:UC_SKQQAB', name: 'Квалифицирован', role: 'qualified' },
  { index: 2, id: 'C78:PREPAYMENT_INVOIC', name: 'Выявлена потребность', role: 'need' },
  { index: 3, id: 'C78:EXECUTING', name: 'Получены исходники', role: 'inputs' },
  { index: 4, id: 'C78:FINAL_INVOICE', name: 'Назначена встреча', role: 'meetingScheduled' },
  { index: 5, id: 'C78:UC_QBAV17', name: 'Встреча проведена', role: 'meetingDone' },
  { index: 6, id: 'C78:UC_Z9A6KT', name: 'Реквизиты получены', role: 'requisites' },
  { index: 7, id: 'C78:UC_50O081', name: 'Договор подписан', role: 'contractSigned' }
];

export const STAGE_BY_ID = new Map(STAGES.map((stage) => [stage.id, stage]));

// Пред-вороночная стадия «Заявки маркетинг» (C78:NEW) — ДО «Взят в работу».
// НЕ входит в воронку (В7/В12), но выбирается как стартовый этап конверсии/цикла (итерация 8).
export const MARKETING_STAGE_ID = 'C78:NEW';

// Достадийные этапы (до воронки): выбираемы как стартовые «от» в конверсии/цикле, но НЕ входят
// в STAGES/воронку и не влияют на индексы этапов (на stageIndex()===-1 завязана вся математика воронки).
export const PRE_FUNNEL_STAGES = [
  { index: -1, id: MARKETING_STAGE_ID, name: 'Заявки маркетинг', role: 'marketing', inFunnel: false }
];

export const PRE_FUNNEL_STAGE_BY_ID = new Map(PRE_FUNNEL_STAGES.map((stage) => [stage.id, stage]));

// Стадия допустима как стартовая («от») в настройках конверсии и цикла сделки.
export function isSelectableStartStage(stageId) {
  const id = canonicalStageId(stageId);
  return STAGE_BY_ID.has(id) || PRE_FUNNEL_STAGE_BY_ID.has(id);
}

export const STAGE_ALIASES = Object.freeze({
  'C78:WON': 'C78:UC_50O081'
});

export const STAGE_IDS = Object.freeze({
  preparation: 'C78:PREPARATION',
  meetingDone: 'C78:UC_QBAV17',
  requisites: 'C78:UC_Z9A6KT',
  contractSigned: 'C78:UC_50O081',
  advanceReceived: 'C78:UC_50O081'
});

export function canonicalStageId(stageId) {
  return STAGE_ALIASES[stageId] || stageId;
}

export function stageIndex(stageId) {
  return STAGE_BY_ID.get(canonicalStageId(stageId))?.index ?? -1;
}

export function isTrackedStage(stageId) {
  return STAGE_BY_ID.has(canonicalStageId(stageId));
}

export function capReachedIndexByCurrentStage(reachedIndex, currentStageId) {
  const currentIndex = stageIndex(currentStageId);
  if (currentIndex < 0) return reachedIndex;
  return Math.min(reachedIndex, currentIndex);
}
