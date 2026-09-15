/**
 * @aigility-harness/dsh-interop — dsh harness 家族互操作实现。
 *
 * Implements the family-neutral `HarnessInterop` contract from
 * `@aigility-harness/core` over the pinned official dsh suite. This is the
 * single place in the workspace that depends on the dsh suite — kernel-*
 * packages stay family-free, so swapping harness families means providing
 * another <family>-interop package behind the same contract.
 */

export { DshInterop } from "./interop.js";
export { dshSuiteVersions, mountDshRow, resolvePluginModule } from "./interop.js";
export type { DshSuiteVersions } from "./interop.js";
export { dshBaseRows, isJsExpr } from "./base-rows.js";
export type { DshBaseRow, JsExpr } from "./base-rows.js";
export { installedDshPackages, disabledToText } from "./installed.js";
export type { InstalledDshPackage } from "./installed.js";
export { dshAgentHeadless } from "./headless.js";
export type { DshHeadlessOptions, DshHeadlessResult } from "./headless.js";
export { evaluateJsExpr, evaluateDeep } from "./js-expr.js";
export type { JsExprEvalContext } from "./js-expr.js";
export {
  TELEMETRY_ROW_ID,
  composeProfileRows,
  mountComposedProfile,
  orderRowIndices,
} from "./profile-composer.js";
export type {
  ComposeProfileOptions,
  ComposeResult,
  ComposedRow,
  DshPatchEntry,
  MountProfileOptions,
  MountProfileResult,
  ProfileRowResult,
  RowDependencyMeta,
} from "./profile-composer.js";
