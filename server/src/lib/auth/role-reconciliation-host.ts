import { z } from "zod";
import {
  confirmRoleState,
  inspectRoleState,
  reconciliationSchema,
  reconciliationTargetSchema,
  type ReconciliationInput,
  type ReconciliationTarget,
} from "./role-reconciliation.js";

const operatorSchema = z.string().trim().min(3).max(200);
/** Trusted OS/DB operator boundary. Never import this wrapper from a runtime route. */
export function inspectRolesForHost(operator: string, target: ReconciliationTarget) {
  return inspectRoleState(
    { kind: "host-operator", name: operatorSchema.parse(operator) },
    reconciliationTargetSchema.parse(target),
  );
}

export function confirmRolesForHost(
  operator: string,
  input: ReconciliationInput,
  confirmation: string,
) {
  const parsed = reconciliationSchema.parse(input);
  if (confirmation !== `${parsed.targetId}:${parsed.username}:${parsed.decision}`) {
    throw new Error("Confirmation must exactly match targetId:username:decision");
  }
  return confirmRoleState({ kind: "host-operator", name: operatorSchema.parse(operator) }, parsed);
}
