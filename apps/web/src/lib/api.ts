import useSWR, { type SWRConfiguration } from "swr";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details?: { issues?: { nodeId?: string; param?: string; message: string }[] },
  ) {
    super(message);
  }
}

export const api = async <T>(method: "GET" | "POST" | "PATCH", path: string, body?: unknown): Promise<T> => {
  const res = await fetch(path, {
    method,
    credentials: "include",
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, json.error ?? res.statusText, json.details);
  return json as T;
};

export const useApi = <T>(path: string | null, config?: SWRConfiguration<T>) =>
  useSWR<T>(path, (p: string) => api<T>("GET", p), config);
