/**
 * Typed clients for the playlist import routes (V2-PLAN T13, /api/import).
 * Errors carry the route's plain `{ error }` text, like app/lib/api.ts.
 */
import type {
  ChunkResponse,
  CreateJobResponse,
  ImportJobSummary,
  ImportJobView,
  ServiceId,
  ServiceOption,
} from "@/lib/import-types";
import { ApiError } from "./api";

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const json = typeof init?.body === "string";
  const response = await fetch(url, {
    ...init,
    headers: json ? { "Content-Type": "application/json", ...init?.headers } : init?.headers,
    cache: "no-store",
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
    const detail = typeof body?.error === "string" && body.error ? body.error : "Something went wrong. Try again.";
    throw new ApiError(response.status, detail);
  }
  return (await response.json()) as T;
}

export async function fetchImportServices(): Promise<ServiceOption[]> {
  return (await request<{ services: ServiceOption[] }>("/api/import/services")).services;
}

export async function fetchImportJobs(): Promise<ImportJobSummary[]> {
  return (await request<{ jobs: ImportJobSummary[] }>("/api/import/jobs")).jobs;
}

export function createLinkImport(service: ServiceId, links: string[]): Promise<CreateJobResponse> {
  return request("/api/import/jobs", { method: "POST", body: JSON.stringify({ service, method: "link", links }) });
}

export function createLoginImport(service: ServiceId): Promise<CreateJobResponse> {
  return request("/api/import/jobs", { method: "POST", body: JSON.stringify({ service, method: "login" }) });
}

export function createFileImport(service: ServiceId, file: File): Promise<CreateJobResponse> {
  const form = new FormData();
  form.set("service", service);
  form.set("method", "file");
  form.set("file", file);
  return request("/api/import/jobs", { method: "POST", body: form });
}

export async function fetchImportJob(id: string): Promise<ImportJobView> {
  return (await request<{ job: ImportJobView }>(`/api/import/jobs/${id}`)).job;
}

export async function listImportJob(id: string): Promise<ImportJobView> {
  return (await request<{ job: ImportJobView }>(`/api/import/jobs/${id}/list`, { method: "POST", body: "{}" })).job;
}

export async function startImportJob(id: string, refs: string[]): Promise<ImportJobView> {
  return (await request<{ job: ImportJobView }>(`/api/import/jobs/${id}/start`, { method: "POST", body: JSON.stringify({ refs }) })).job;
}

export function runImportChunk(id: string): Promise<ChunkResponse> {
  return request(`/api/import/jobs/${id}/chunk`, { method: "POST", body: "{}" });
}

export async function skipImportSong(id: string, itemId: string): Promise<ImportJobView> {
  return (await request<{ job: ImportJobView }>(`/api/import/jobs/${id}/skip`, { method: "POST", body: JSON.stringify({ itemId }) })).job;
}
