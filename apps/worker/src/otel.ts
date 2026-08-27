/**
 * OTEL bootstrap — Observability section: "native OTEL export endpoint, free, default-on, BYO
 * backend." Default-on means the SDK/instrumentation code always ships; "inert until set" (per
 * docker-compose.yml's own comment on `OTEL_EXPORTER_OTLP_ENDPOINT`) means it does nothing at
 * runtime unless the customer actually points it at their own OTLP collector — WarmHawk never
 * operates or receives this telemetry itself.
 *
 * MUST be imported before any other module that OTEL's auto-instrumentation needs to patch
 * (ioredis, http, etc.) — see `index.ts`, which imports this immediately after `dotenv/config`
 * and before everything else. This file has no side effects of its own beyond reading env vars
 * until `startOtel()` is called from `index.ts`.
 *
 * Identical to `apps/api/src/otel.ts` apart from the default service name — small, deliberate
 * duplication across these two independently-deployable apps, matching this repo's existing
 * convention for `apps/api/src/routes/queue.ts`'s constants (no shared package between them).
 */
import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';

let sdk: NodeSDK | null = null;

/** No-ops when `OTEL_EXPORTER_OTLP_ENDPOINT` is unset — this is what "default-on, inert until
 *  set" means in practice: the code path always ships, nothing is exported until a real endpoint
 *  is configured. Safe to call more than once; only the first call with a set endpoint does
 *  anything. */
export function startOtel(): void {
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint || sdk) return;

  sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME || 'warmhawk-worker',
    }),
    traceExporter: new OTLPTraceExporter({ url: endpoint }),
    instrumentations: [getNodeAutoInstrumentations()],
  });

  sdk.start();
}

/** Flushes/shuts down the exporter cleanly — called from `index.ts`'s existing SIGINT/SIGTERM
 *  handler, so in-flight spans aren't dropped on a graceful shutdown. No-op if OTEL was never
 *  started. */
export async function shutdownOtel(): Promise<void> {
  await sdk?.shutdown().catch(() => undefined);
}
