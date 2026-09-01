/** Minimal, strict OTLP/HTTP JSON log receiver mapping for physical telemetry. */

import { otlpRequestIdentity, type ProjectCargoActionRequest } from './projectCargoActions';
import type { OTelAttributeValue, TelemetrySignal } from './projectCargoStore';
import type { ISODateTime } from './types';

export type OtlpDecodeRefusal = { readonly kind: 'refusal'; readonly detail: string };
export type OtlpDecodedLog = {
  readonly request: Extract<ProjectCargoActionRequest, { action: 'ingest_telemetry' }>;
  readonly externalReference: string;
};

type UnknownRecord = Record<string, unknown>;

function object(value: unknown): UnknownRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as UnknownRecord : null;
}

function array(value: unknown): readonly unknown[] { return Array.isArray(value) ? value : []; }

function anyValue(value: unknown): OTelAttributeValue | null {
  const item = object(value);
  if (!item) return null;
  if (typeof item.stringValue === 'string') return item.stringValue;
  if (typeof item.doubleValue === 'number' && Number.isFinite(item.doubleValue)) return item.doubleValue;
  if ((typeof item.intValue === 'string' || typeof item.intValue === 'number') && Number.isFinite(Number(item.intValue))) return Number(item.intValue);
  if (typeof item.boolValue === 'boolean') return item.boolValue;
  const values = object(item.arrayValue)?.values;
  if (Array.isArray(values)) {
    const decoded = values.map(anyValue);
    if (decoded.every(entry => typeof entry === 'string')) return decoded as string[];
    if (decoded.every(entry => typeof entry === 'number')) return decoded as number[];
    if (decoded.every(entry => typeof entry === 'boolean')) return decoded as boolean[];
  }
  return null;
}

function attributes(value: unknown): Record<string, OTelAttributeValue> {
  const output: Record<string, OTelAttributeValue> = {};
  for (const raw of array(value).slice(0, 128)) {
    const item = object(raw);
    if (!item || typeof item.key !== 'string' || item.key in output) continue;
    const decoded = anyValue(item.value);
    if (decoded !== null) output[item.key] = decoded;
  }
  return output;
}

function isoFromNanos(value: unknown): ISODateTime | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  try {
    const milliseconds = Math.floor(Number(value) / 1_000_000);
    const date = new Date(milliseconds);
    return Number.isFinite(date.valueOf()) ? date.toISOString() : null;
  } catch { return null; }
}

function scalarAttributes(value: Record<string, OTelAttributeValue>): Record<string, string | number | boolean> {
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string | number | boolean] => !Array.isArray(entry[1])));
}

const SIGNALS = new Set<TelemetrySignal>(['temperature', 'relative_humidity', 'shock', 'vibration', 'tilt', 'door', 'seal', 'location']);
const ID = /^[A-Za-z0-9][A-Za-z0-9:_./-]{0,179}$/;

export function decodeOtlpJsonLogs(input: unknown, sourceId: string, observedAt: ISODateTime): readonly OtlpDecodedLog[] | OtlpDecodeRefusal {
  if (!ID.test(sourceId)) return { kind: 'refusal', detail: 'x-payload-source-id must be a stable machine identifier.' };
  const root = object(input);
  if (!root) return { kind: 'refusal', detail: 'OTLP export request must be a JSON object.' };
  const decoded: OtlpDecodedLog[] = [];
  for (const rawResourceLogs of array(root.resourceLogs)) {
    const resourceLogs = object(rawResourceLogs); if (!resourceLogs) continue;
    const resource = attributes(object(resourceLogs.resource)?.attributes);
    for (const rawScopeLogs of array(resourceLogs.scopeLogs)) {
      const scopeLogs = object(rawScopeLogs); if (!scopeLogs) continue;
      for (const rawRecord of array(scopeLogs.logRecords)) {
        if (decoded.length >= 500) return { kind: 'refusal', detail: 'One OTLP request may contain at most 500 log records.' };
        const record = object(rawRecord); if (!record) continue;
        const attrs = attributes(record.attributes);
        const projectId = resource['payload.project.id'];
        const cargoItemId = resource['payload.cargo.item.id'];
        const sensorId = resource['device.id'];
        const signal = attrs['payload.telemetry.signal'];
        const unit = attrs['payload.telemetry.unit'];
        const measuredAt = isoFromNanos(record.timeUnixNano);
        const eventName = record.eventName;
        if (typeof projectId !== 'string' || typeof cargoItemId !== 'string' || typeof sensorId !== 'string' || typeof signal !== 'string' || !SIGNALS.has(signal as TelemetrySignal) || typeof unit !== 'string' || !measuredAt || eventName !== 'payload.cargo.condition.observed') {
          return { kind: 'refusal', detail: 'Each log needs canonical eventName, source timestamp, payload.project.id, payload.cargo.item.id, device.id, payload.telemetry.signal, and payload.telemetry.unit.' };
        }
        const value = attrs['payload.telemetry.value'];
        if (typeof value !== 'number' && typeof value !== 'string') return { kind: 'refusal', detail: 'payload.telemetry.value must be a number or string.' };
        const body = anyValue(record.body);
        const normalized = { resource, attributes: attrs, timeUnixNano: record.timeUnixNano, eventName, traceId: record.traceId, spanId: record.spanId, body };
        const externalReference = otlpRequestIdentity(sourceId, normalized);
        const request: Extract<ProjectCargoActionRequest, { action: 'ingest_telemetry' }> = {
          action: 'ingest_telemetry', requestId: externalReference, actorId: `sensor:${sourceId}`, submittedAt: observedAt,
          payload: {
            projectId, cargoItemId, sensorId, signal: signal as TelemetrySignal,
            ...(typeof value === 'number' ? { numericValue: value } : { textValue: value }),
            unit, measuredAt,
            ...(typeof record.traceId === 'string' && record.traceId ? { traceId: record.traceId.toLowerCase() } : {}),
            ...(typeof record.spanId === 'string' && record.spanId ? { spanId: record.spanId.toLowerCase() } : {}),
            attributes: scalarAttributes(attrs), sourceReference: externalReference,
          },
        };
        decoded.push(Object.freeze({ request, externalReference }));
      }
    }
  }
  if (decoded.length === 0) return { kind: 'refusal', detail: 'OTLP request contains no log records.' };
  return Object.freeze(decoded);
}
