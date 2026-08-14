/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_ENABLE_SYNC?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

import type {
  PriceOverrides,
  PricingCatalogRow,
  ScanResult,
  SessionDetail,
  SessionTranscript,
} from "./types";

export interface SyncConfigPublic {
  supabaseUrl: string;
  supabaseAnonKey: string;
  lastSyncAt: string | null;
  deviceLabel: string | null;
  hasSession: boolean;
  email: string | null;
  userId: string | null;
}

export type SyncIpcResult<T = Record<string, unknown>> = {
  ok: boolean;
  error?: string;
} & T;

declare global {
  interface Window {
    tokenStats?: {
      scan: (opts?: { clients?: string[] }) => Promise<ScanResult>;
      sessionDetail?: (opts: {
        client: string;
        sessionId: string;
        mergedChildren?: string[];
      }) => Promise<{ ok: boolean; error?: string; detail?: SessionDetail }>;
      sessionTranscript?: (opts: {
        client: string;
        sessionId: string;
        mergedChildren?: string[];
      }) => Promise<{
        ok: boolean;
        error?: string;
        transcript?: SessionTranscript;
      }>;
      pricing?: {
        get: () => Promise<
          SyncIpcResult<{
            overrides: PriceOverrides;
            catalog: PricingCatalogRow[];
            loadError?: string | null;
            path?: string;
          }>
        >;
        save: (payload: {
          models?: PriceOverrides["models"];
          aliases?: PriceOverrides["aliases"];
        }) => Promise<
          SyncIpcResult<{
            overrides: PriceOverrides;
            catalog: PricingCatalogRow[];
            loadError?: string | null;
            path?: string;
          }>
        >;
      };
      sync?: {
        getConfig: () => Promise<SyncIpcResult<{ config: SyncConfigPublic }>>;
        saveConfig: (patch: {
          supabaseUrl?: string;
          supabaseAnonKey?: string;
          deviceLabel?: string;
        }) => Promise<SyncIpcResult<{ config: SyncConfigPublic }>>;
        signIn: (opts: {
          email: string;
          password: string;
          mode?: "login" | "signup";
        }) => Promise<
          SyncIpcResult<{
            config: SyncConfigPublic;
            email?: string;
            userId?: string;
          }>
        >;
        signOut: () => Promise<SyncIpcResult<{ config: SyncConfigPublic }>>;
        upload: (
          scanResult?: ScanResult | null
        ) => Promise<
          SyncIpcResult<{
            config: SyncConfigPublic;
            sessionCount?: number;
            totalTokens?: number;
            costUsd?: number | null;
            lastSyncAt?: string;
          }>
        >;
        status: () => Promise<
          SyncIpcResult<{ config: SyncConfigPublic; configured?: boolean }>
        >;
      };
    };
  }
}

export {};
