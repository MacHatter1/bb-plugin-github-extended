import { useEffect, useRef, useState } from "react";
import {
  experimental_ProviderModelPicker as ProviderModelPicker,
  useBbContext,
  useRpc,
  useSdk,
} from "@get-bb/plugin-sdk/app";
import type { githubRpcContract } from "./server.js";
import type { RuleExecution } from "./automation/domain.js";
import { Button, Spinner } from "./shared-ui.js";

/** The host picker owns live provider/model/thinking reconciliation. */
export function RuleAgentSettings({ value, repo, onChange }: {
  value?: RuleExecution;
  repo?: string;
  onChange: (value: RuleExecution | undefined) => void;
}) {
  const sdk = useSdk();
  const rpc = useRpc<typeof githubRpcContract>();
  const current = useBbContext();
  const [target, setTarget] = useState<{ repo?: string; projectId: string; hostId: string } | null>(null);
  const [targetError, setTargetError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [choosing, setChoosing] = useState(false);
  const [retry, setRetry] = useState(0);
  const choice = useRef<AbortController | null>(null);

  useEffect(() => {
    let cancelled = false;
    setTarget(null);
    setTargetError(null);
    setError(null);
    setChoosing(false);
    if (repo) void rpc.call("agentTaskContext", { repo }).then(
      (result) => { if (!cancelled) setTarget({ ...result, repo }); },
      (failure: unknown) => { if (!cancelled) setTargetError(failure instanceof Error ? failure.message : String(failure)); },
    );
    return () => { cancelled = true; choice.current?.abort(); };
  }, [rpc, repo, retry]);

  const readyTarget = target?.repo === repo ? target : null;
  const waiting = !!repo && !readyTarget && !targetError;
  const choose = async () => {
    const controller = new AbortController();
    choice.current = controller;
    const signal = controller.signal;
    setChoosing(true);
    setError(null);
    try {
      const projectId = readyTarget?.projectId ?? current.projectId ?? undefined;
      const defaults = projectId ? await sdk.projects.defaultExecutionOptions({ projectId, signal }) : null;
      signal.throwIfAborted();
      if (defaults) {
        const { providerId, model, reasoningLevel, serviceTier } = defaults;
        onChange({ providerId, model, reasoningLevel, serviceTier });
      } else {
        const route = readyTarget ? { hostId: readyTarget.hostId } : {};
        const providers = await sdk.providers.list({ ...route, signal });
        const provider = providers.find((entry) => entry.available);
        if (!provider) throw new Error("No agent provider is available. Configure one in BB Settings.");
        const catalog = await sdk.providers.models({ ...route, ...(projectId ? { projectId } : {}), providerId: provider.id, signal });
        signal.throwIfAborted();
        if (catalog.modelLoadError) throw new Error(catalog.modelLoadError.detail ?? "Could not load agent models.");
        const model = catalog.models.find((entry) => entry.isDefault) ?? catalog.models[0];
        if (!model) throw new Error("No models are available for this provider.");
        onChange({ providerId: provider.id, model: model.model, reasoningLevel: model.defaultReasoningEffort });
      }
    } catch (failure) {
      if (!signal.aborted) setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      if (!signal.aborted) setChoosing(false);
    }
  };

  return (
    <fieldset className="gh-field-group">
      <legend>Agent</legend>
      <p className="text-xs text-muted-foreground">
        {value ? "Choose the provider, model, and thinking level for this rule's agent actions." : "Uses each repository project's provider, model, and thinking defaults."}
      </p>
      {value && !waiting && !targetError ? (
        <ProviderModelPicker
          value={value}
          onChange={onChange}
          routing={readyTarget ? { kind: "host", hostId: readyTarget.hostId } : undefined}
        />
      ) : null}
      {waiting && value ? <p role="status" className="text-xs"><Spinner className="size-3" /> Loading agent settings…</p> : null}
      {targetError ? (
        <p role="alert" className="text-xs text-destructive">
          {targetError}{" "}
          <Button size="sm" variant="ghost" onClick={() => setRetry((count) => count + 1)}>Retry</Button>
        </p>
      ) : null}
      {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
      <Button
        size="sm"
        variant="outline"
        aria-label={value ? "Use project defaults" : "Choose provider, model and thinking"}
        disabled={!value && (choosing || waiting || !!targetError)}
        onClick={value ? () => { setError(null); onChange(undefined); } : () => void choose()}
      >
        {choosing ? <Spinner className="size-3" /> : null}
        {value ? "Use project defaults" : "Choose provider, model and thinking"}
      </Button>
    </fieldset>
  );
}
