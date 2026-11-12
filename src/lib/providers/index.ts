// سجل المزودات — جلب المزود المناسب حسب معرّفه
import { kieAdapter } from "./kie";
import { cometapiAdapter } from "./cometapi";
import type { ProviderAdapter, ProviderId } from "../types";

const ADAPTERS: Record<ProviderId, ProviderAdapter> = {
  kie: kieAdapter,
  cometapi: cometapiAdapter,
};

export function getAdapter(provider: string): ProviderAdapter {
  const a = ADAPTERS[provider as ProviderId];
  if (!a) throw new Error(`مزود غير معروف: ${provider}`);
  return a;
}
