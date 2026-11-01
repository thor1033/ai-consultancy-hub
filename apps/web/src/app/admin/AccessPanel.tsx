"use client";

import { useCallback, useEffect, useRef, useState } from"react";
import { useView } from "@/components/ViewProvider";
import {
  loadAccessAction,
  savePrincipalAction,
  setPrincipalEnabledAction,
  issueCredentialAction,
  revokeCredentialAction,
  setCollectionVisibilityAction,
  setCollectionSensitivityAction,
  grantCollectionAction,
  revokeCollectionAction,
} from"./accessActions";
import { SENSITIVITY_WORDS } from "@/lib/sensitivityWords";
import type {
  AccessSnapshot,
  AccessCredential,
  AccessPrincipal,
  AccessCollection,
} from"./types";

const ROLES = ["admin","analyst","viewer"] as const;

export function AccessPanel() {
  const [snap, setSnap] = useState<AccessSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  // The plaintext of a credential just issued. Held in component state only —
  // it is the one moment it exists outside a hash, and it dies with the tab.
  const [freshToken, setFreshToken] = useState<{ name: string; token: string } | null>(null);
  // Below Expert, the page is about people and what they may read
  // (docs/views.md). Sign-in protocol, machine credentials and the audit trail
  // are for whoever wires the hub to other systems — one switch away.
  const expert = useView().view === "expert";

  const apply = useCallback((out: AccessSnapshot | { error: string }) => {
    if ("error" in out) setError(out.error);
    else {
      setSnap(out);
      setError(null);
    }
  }, []);

  const reload = useCallback(async () => {
    setLoading(true);
    apply(await loadAccessAction());
    setLoading(false);
  }, [apply]);

  useEffect(() => {
    void reload();
  }, [reload]);

  if (loading && !snap) {
    return <p className="text-sm text-[var(--muted)]">Loading access…</p>;
  }

  if (!snap) {
    return (
      <div className="panel notice-danger p-4 text-sm text-[var(--danger)]">
        {error ??"Access is unavailable."}
      </div>
    );
  }

  async function run(key: string, fn: () => Promise<AccessSnapshot | { error: string }>) {
    setBusy(key);
    apply(await fn());
    setBusy(null);
  }

  return (
    <div className="space-y-8">
      {error && (
        <div className="panel notice-danger p-3 text-sm text-[var(--danger)]">
          {error}
        </div>
      )}

      {expert && <OAuthStatusCard snap={snap} />}

      <section>
        <SectionHeading
          title="People"
          subtitle={
            expert
              ? "Who the hub knows. An OAuth sign-in proves identity; this is what grants it permission. Disabling a person takes every credential they hold out of service at once."
              : "Who may use the hub, and how much they may do. Add someone by their work email; they sign in with their usual account. Switching a person off stops them at once."
          }
        />
        <PrincipalList
          snap={snap}
          busy={busy}
          onToggle={(p) =>
            run(`p:${p.id}`, () => setPrincipalEnabledAction(p.id, !p.enabled))
          }
        />
        <PrincipalForm
          busy={busy ==="save-principal"}
          onSave={(input) => run("save-principal", () => savePrincipalAction(input))}
        />
      </section>

      {expert && (
      <section>
        <SectionHeading
          title="Credentials"
          subtitle="Long-lived bearer tokens for clients that cannot do OAuth — CI, a cron job, another hub. Revoking one takes effect on the next request, with no deploy."
        />
        {freshToken && (
          <FreshToken
            name={freshToken.name}
            token={freshToken.token}
            onDismiss={() => setFreshToken(null)}
          />
        )}
        <CredentialList
          snap={snap}
          busy={busy}
          onRevoke={(c) => {
            if (!confirm(`Revoke"${c.name}" (${c.tokenPrefix}…)? Any client using it stops working immediately.`))
              return;
            void run(`c:${c.id}`, () => revokeCredentialAction(c.id));
          }}
        />
        <IssueForm
          principals={snap.principals}
          busy={busy ==="issue"}
          onIssue={async (input) => {
            setBusy("issue");
            const out = await issueCredentialAction(input);
            if ("error" in out) setError(out.error);
            else {
              setSnap(out.snapshot);
              setError(null);
              setFreshToken({ name: input.name, token: out.token });
            }
            setBusy(null);
          }}
        />
      </section>
      )}

      <section>
        <SectionHeading
          title="Knowledge"
          subtitle={
            expert
              ? "Which shared drives each person may open. A restricted collection is readable only by the people granted it — search, document reads and the collection list all narrow the same way, so there is no way round it."
              : "Which folders of documents each person may read. A private folder is readable only by the people you name — and so are the agents' answers drawn from it."
          }
        />
        <KnowledgeList
          snap={snap}
          busy={busy}
          onToggle={(c) =>
            run(`k:${c.name}`, () =>
              setCollectionVisibilityAction(
                c.name,
                c.visibility ==="open" ?"restricted" :"open",
              ),
            )
          }
          onLabel={(c, label) => run(`k:${c.name}`, () => setCollectionSensitivityAction(c.name, label))}
          onGrant={(collection, principalId) =>
            run(`k:${collection}`, () => grantCollectionAction(collection, principalId))
          }
          onRevoke={(collection, principalId) =>
            run(`k:${collection}`, () => revokeCollectionAction(collection, principalId))
          }
        />
      </section>

      {expert && (
      <section>
        <SectionHeading
          title="Audit"
          subtitle="Credentials issued and revoked, people changed, and every authentication that failed. Successful calls are not listed one by one — that is what “last used” on a credential is for."
        />
        <AuditList snap={snap} />
      </section>
      )}
    </div>
  );
}

function OAuthStatusCard({ snap }: { snap: AccessSnapshot }) {
  const { oauth, legacyTokens } = snap;
  return (
    <section className="panel p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-semibold">OAuth 2.1</h2>
        <span
          className={`px-2 py-0.5 text-[10px] uppercase tracking-[0.18em] ${
            oauth.configured
              ?"bg-[var(--brand-soft)] text-[var(--positive)]"
              :"border border-[var(--border)] text-[var(--muted)]"
          }`}
        >
          {oauth.configured ?"Configured" :"Not configured"}
        </span>
      </div>

      {oauth.configured ? (
        <dl className="mono mt-3 grid gap-1 text-xs text-[var(--muted)]">
          <div>
            <dt className="inline">Authorization server: </dt>
            <dd className="inline text-[var(--text-soft)]">{oauth.issuer}</dd>
          </div>
          <div>
            <dt className="inline">Resource indicator: </dt>
            <dd className="inline text-[var(--text-soft)]">{oauth.resource}</dd>
          </div>
          <div>
            <dt className="inline">Metadata: </dt>
            <dd className="inline text-[var(--text-soft)]">{oauth.metadataUrl}</dd>
          </div>
        </dl>
      ) : (
        <p className="mt-2 text-sm text-[var(--text-soft)]">
          Set <code>WORKOS_AUTHKIT_DOMAIN</code> and <code>HUB_MCP_RESOURCE</code> to publish
          resource metadata. Until then the hub is reachable by credential only — which no
          enterprise surface can enrol.
        </p>
      )}

      {legacyTokens > 0 && (
        <p className="mt-3 border-t border-[var(--border)] pt-3 text-sm text-[var(--text-soft)]">
          <strong className="text-[var(--danger)]">
            {legacyTokens} legacy {legacyTokens === 1 ?"token" :"tokens"}
          </strong>{""}
          still resolve from <code>HUB_API_TOKENS</code>. They cannot be revoked from here — every
          deploy replaces the whole map. Reissue each as a credential, set{""}
          <code>HUB_DISABLE_LEGACY_TOKENS=1</code>, then delete the secret.
        </p>
      )}
    </section>
  );
}

function FreshToken({
  name,
  token,
  onDismiss,
}: {
  name: string;
  token: string;
  onDismiss: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  // The issue form sits at the bottom of a long page; without this the one-time
  // token renders out of view and is easily lost.
  useEffect(() => {
    ref.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [token]);
  return (
    <div ref={ref} className="panel notice-info mb-3 p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold">Copy “{name}” now</h3>
          <p className="mt-0.5 text-sm text-[var(--muted)]">
            This is the only time it is shown. The hub stores a hash, so a lost credential is
            revoked and reissued, never recovered.
          </p>
        </div>
        <button onClick={onDismiss} className="chip shrink-0" aria-label="Dismiss">
          Done
        </button>
      </div>
      <div className="mt-3 flex items-center gap-2">
        <code className="mono min-w-0 flex-1 select-all overflow-x-auto border border-[var(--border)] bg-[var(--panel-inset)] p-2 text-xs">
          {token}
        </code>
        <button
          className="chip shrink-0"
          onClick={() => {
            void navigator.clipboard?.writeText(token).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            });
          }}
        >
          {copied ?"Copied" :"Copy"}
        </button>
      </div>
    </div>
  );
}

function PrincipalList({
  snap,
  busy,
  onToggle,
}: {
  snap: AccessSnapshot;
  busy: string | null;
  onToggle: (p: AccessPrincipal) => void;
}) {
  if (!snap.principals.length) {
    return (
      <p className="panel p-4 text-sm text-[var(--muted)]">
        Nobody yet. Add yourself below with the <code>admin</code> role — an OAuth token only gets
        in if the email behind it matches a person here.
      </p>
    );
  }
  return (
    <div className="space-y-2">
      {snap.principals.map((p) => (
        <div
          key={p.id}
          className={`panel flex items-start justify-between gap-4 p-4 ${p.enabled ?"" :"opacity-65"}`}
        >
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="font-medium text-[var(--text)]">{p.displayName || p.id}</h3>
              {p.roles.map((r) => (
                <span
                  key={r}
                  className="bg-[var(--brand-soft)] px-2 py-0.5 text-[10px] uppercase tracking-[0.18em] text-[var(--positive)]"
                >
                  {r}
                </span>
              ))}
              {!p.roles.length && (
                <span className="border border-[var(--border)] px-2 py-0.5 text-[10px] uppercase tracking-[0.18em] text-[var(--muted)]">
                  no roles
                </span>
              )}
            </div>
            <div className="mono mt-1 text-xs text-[var(--muted)]">
              {p.id}
              {p.email ?` · ${p.email}` :" · no email — OAuth cannot match this person"}
              {p.workosBound ?" · WorkOS bound" :""}
              {p.agentId ?` · agent ${p.agentId}` :""}
              {` · ${p.credentialCount} credential${p.credentialCount === 1 ?"" :"s"}`}
            </div>
          </div>
          <button
            onClick={() => onToggle(p)}
            disabled={busy ===`p:${p.id}`}
            className="chip shrink-0 disabled:opacity-50"
          >
            {p.enabled ?"Disable" :"Enable"}
          </button>
        </div>
      ))}
    </div>
  );
}

function PrincipalForm({
  busy,
  onSave,
}: {
  busy: boolean;
  onSave: (input: {
    id: string;
    email: string;
    displayName: string;
    roles: string[];
    agentId: string;
  }) => void;
}) {
  const [id, setId] = useState("");
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [roles, setRoles] = useState<string[]>([]);
  const [agentId, setAgentId] = useState("");

  return (
    <form
      className="panel mt-3 p-4"
      onSubmit={(e) => {
        e.preventDefault();
        onSave({ id, email, displayName, roles, agentId });
        setId("");
        setEmail("");
        setDisplayName("");
        setRoles([]);
        setAgentId("");
      }}
    >
      <h3 className="text-sm font-semibold">Add or update a person</h3>
      <p className="mt-0.5 text-sm text-[var(--muted)]">
        Saving an existing id overwrites it. The email is what an AuthKit token is matched on.
      </p>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <Field label="Id" value={id} onChange={setId} placeholder="ditlev-brygmann" required />
        <Field label="Email" value={email} onChange={setEmail} placeholder="name@company.com" />
        <Field label="Name" value={displayName} onChange={setDisplayName} placeholder="Ditlev Brygmann" />
        <Field
          label="Agent binding (optional)"
          value={agentId}
          onChange={setAgentId}
          placeholder="delivery-lead"
        />
      </div>
      <RolePicker roles={roles} setRoles={setRoles} />
      <button type="submit" disabled={busy || !id.trim()} className="btn-brand mt-4">
        {busy ?"Saving…" :"Save person"}
      </button>
    </form>
  );
}

function CredentialList({
  snap,
  busy,
  onRevoke,
}: {
  snap: AccessSnapshot;
  busy: string | null;
  onRevoke: (c: AccessCredential) => void;
}) {
  if (!snap.credentials.length) {
    return (
      <p className="panel p-4 text-sm text-[var(--muted)]">
        No credentials issued. Most clients should use OAuth instead — issue one of these only
        where OAuth is impossible.
      </p>
    );
  }
  return (
    <div className="space-y-2">
      {snap.credentials.map((c) => (
        <div key={c.id} className="panel flex items-start justify-between gap-4 p-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="font-medium text-[var(--text)]">{c.name}</h3>
              {c.roles.map((r) => (
                <span
                  key={r}
                  className="bg-[var(--brand-soft)] px-2 py-0.5 text-[10px] uppercase tracking-[0.18em] text-[var(--positive)]"
                >
                  {r}
                </span>
              ))}
            </div>
            <div className="mono mt-1 text-xs text-[var(--muted)]">
              {c.tokenPrefix}… · {c.principalId}
              {c.agentId ?` · agent ${c.agentId}` :""}
              {` · issued ${shortDate(c.createdAt)}`}
              {c.createdBy ?` by ${c.createdBy}` :""}
              {` · ${c.lastUsedAt ?`last used ${shortDate(c.lastUsedAt)}` :"never used"}`}
              {c.expiresAt ?` · expires ${shortDate(c.expiresAt)}` :""}
            </div>
          </div>
          <button
            onClick={() => onRevoke(c)}
            disabled={busy ===`c:${c.id}`}
            className="chip shrink-0 text-[var(--danger)] disabled:opacity-50"
          >
            Revoke
          </button>
        </div>
      ))}
    </div>
  );
}

function IssueForm({
  principals,
  busy,
  onIssue,
}: {
  principals: AccessPrincipal[];
  busy: boolean;
  onIssue: (input: {
    name: string;
    principalId: string;
    roles: string[];
    agentId: string;
    expiresInDays: number | null;
  }) => void;
}) {
  const [name, setName] = useState("");
  const [principalId, setPrincipalId] = useState("");
  const [roles, setRoles] = useState<string[]>([]);
  const [agentId, setAgentId] = useState("");
  const [expiry, setExpiry] = useState("");

  const canIssue = Boolean(name.trim() && principalId && !busy);

  return (
    <form
      className="panel mt-3 p-4"
      onSubmit={(e) => {
        e.preventDefault();
        onIssue({
          name,
          principalId,
          roles,
          agentId,
          expiresInDays: expiry.trim() ? Number(expiry) : null,
        });
        setName("");
        setRoles([]);
        setAgentId("");
        setExpiry("");
      }}
    >
      <h3 className="text-sm font-semibold">Issue a credential</h3>
      <p className="mt-0.5 text-sm text-[var(--muted)]">
        Leave roles empty to inherit the person&apos;s own. Chosen roles narrow, never widen.
      </p>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <Field label="Name" value={name} onChange={setName} placeholder="CI — nightly ingest" required />
        <label className="block">
          <div className="mb-1 text-xs text-[var(--muted)]">Belongs to</div>
          <select
            className="field"
            value={principalId}
            onChange={(e) => setPrincipalId(e.target.value)}
            required
          >
            <option value="">Choose a person…</option>
            {principals.map((p) => (
              <option key={p.id} value={p.id}>
                {p.displayName || p.id}
                {p.enabled ?"" :" (disabled)"}
              </option>
            ))}
          </select>
        </label>
        <Field
          label="Agent binding (optional)"
          value={agentId}
          onChange={setAgentId}
          placeholder="delivery-lead"
        />
        <Field
          label="Expires in days (optional)"
          value={expiry}
          onChange={setExpiry}
          placeholder="90"
        />
      </div>
      <RolePicker roles={roles} setRoles={setRoles} />
      <button type="submit" disabled={!canIssue} className="btn-brand mt-4">
        {busy ?"Issuing…" :"Issue credential"}
      </button>
    </form>
  );
}

function KnowledgeList({
  snap,
  busy,
  onToggle,
  onLabel,
  onGrant,
  onRevoke,
}: {
  snap: AccessSnapshot;
  busy: string | null;
  onToggle: (c: AccessCollection) => void;
  onLabel: (c: AccessCollection, label: AccessCollection["sensitivity"]) => void;
  onGrant: (collection: string, principalId: string) => void;
  onRevoke: (collection: string, principalId: string) => void;
}) {
  const { collections, defaultVisibility, unfiledDocuments } = snap.knowledge;
  const unclassified = collections.filter((c) => c.unclassified);

  return (
    <div className="space-y-2">
      <div className="panel p-4">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-semibold">Default for anything unclassified</h3>
          <span
            className={`px-2 py-0.5 text-[10px] uppercase tracking-[0.18em] ${
              defaultVisibility ==="restricted"
                ?"bg-[var(--brand-soft)] text-[var(--positive)]"
                :"border border-[var(--border)] text-[var(--muted)]"
            }`}
          >
            {defaultVisibility}
          </span>
        </div>
        {defaultVisibility ==="open" ? (
          <p className="mt-2 text-sm text-[var(--text-soft)]">
            {unclassified.length > 0 ? (
              <>
                <strong className="text-[var(--danger)]">
                  {unclassified.length} unclassified{""}
                  {unclassified.length === 1 ?"collection" :"collections"}
                </strong>{""}
                and <strong>{unfiledDocuments}</strong> unfiled{""}
                {unfiledDocuments === 1 ?"document" :"documents"} are readable by everyone
                who can authenticate. Classify them, then set{""}
                <code>HUB_DEFAULT_COLLECTION_VISIBILITY=restricted</code>.
              </>
            ) : (
              <>
                Everything is classified. Set{""}
                <code>HUB_DEFAULT_COLLECTION_VISIBILITY=restricted</code> so anything added
                later is private until it is granted.
              </>
            )}
          </p>
        ) : (
          <p className="mt-2 text-sm text-[var(--text-soft)]">
            Nothing is readable without an explicit grant, including the{""}
            <strong>{unfiledDocuments}</strong> unfiled{""}
            {unfiledDocuments === 1 ?"document" :"documents"} — a document in no collection
            has no drawer to be granted on.
          </p>
        )}
      </div>

      {!collections.length && (
        <p className="panel p-4 text-sm text-[var(--muted)]">No collections yet.</p>
      )}

      {collections.map((c) => (
        <CollectionRowView
          key={c.name}
          collection={c}
          principals={snap.principals}
          busy={busy ===`k:${c.name}`}
          onToggle={() => onToggle(c)}
          onLabel={(label) => onLabel(c, label)}
          onGrant={(pid) => onGrant(c.name, pid)}
          onRevoke={(pid) => onRevoke(c.name, pid)}
        />
      ))}
    </div>
  );
}

function CollectionRowView({
  collection: c,
  principals,
  busy,
  onToggle,
  onLabel,
  onGrant,
  onRevoke,
}: {
  collection: AccessCollection;
  principals: AccessPrincipal[];
  busy: boolean;
  onToggle: () => void;
  onLabel: (label: AccessCollection["sensitivity"]) => void;
  onGrant: (principalId: string) => void;
  onRevoke: (principalId: string) => void;
}) {
  const [pick, setPick] = useState("");
  const ungranted = principals.filter((p) => !c.grantedTo.includes(p.id));

  return (
    <div className="panel p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-medium text-[var(--text)]">{c.name}</h3>
            <span
              className={`px-2 py-0.5 text-[10px] uppercase tracking-[0.18em] ${
                c.visibility ==="restricted"
                  ?"bg-[var(--brand-soft)] text-[var(--positive)]"
                  :"border border-[var(--border)] text-[var(--muted)]"
              }`}
            >
              {c.visibility}
            </span>
            {c.unclassified && (
              <span className="border border-[var(--border)] px-2 py-0.5 text-[10px] uppercase tracking-[0.18em] text-[var(--danger)]">
                unclassified
              </span>
            )}
            {c.sensitivity !== "internal" && (
              <span className="border border-[var(--danger)] px-2 py-0.5 text-[10px] uppercase tracking-[0.18em] text-[var(--danger)]">
                {SENSITIVITY_WORDS[c.sensitivity].label}
              </span>
            )}
          </div>
          <div className="mono mt-1 text-xs text-[var(--muted)]">
            {c.documentCount} {c.documentCount === 1 ?"document" :"documents"}
            {c.visibility ==="restricted"
              ?` · ${c.grantedTo.length} granted`
              :" · readable by everyone"}
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
          <label className="sr-only" htmlFor={`label-${c.name}`}>
            Sensitivity of {c.name}
          </label>
          <select
            id={`label-${c.name}`}
            className="field w-auto py-1 text-xs"
            value={c.sensitivity}
            disabled={busy}
            onChange={(e) => onLabel(e.target.value as AccessCollection["sensitivity"])}
            title={SENSITIVITY_WORDS[c.sensitivity].means}
          >
            {(["internal", "confidential", "special"] as const).map((l) => (
              <option key={l} value={l}>
                {SENSITIVITY_WORDS[l].label}
              </option>
            ))}
          </select>
          <button onClick={onToggle} disabled={busy} className="chip shrink-0 disabled:opacity-50">
            {c.visibility ==="open" ?"Restrict" :"Open to all"}
          </button>
        </div>
      </div>
      {c.sensitivity !== "internal" && (
        <p className="mt-2 text-xs text-[var(--text-soft)]">{SENSITIVITY_WORDS[c.sensitivity].means}</p>
      )}

      {c.visibility ==="restricted" && (
        <div className="mt-3 border-t border-[var(--border)] pt-3">
          {c.grantedTo.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-2">
              {c.grantedTo.map((pid) => (
                <button
                  key={pid}
                  onClick={() => onRevoke(pid)}
                  disabled={busy}
                  title={`Revoke ${pid}`}
                  className="chip disabled:opacity-50"
                >
                  {pid} ✕
                </button>
              ))}
            </div>
          )}
          <div className="flex items-center gap-2">
            <select
              className="field max-w-xs"
              value={pick}
              onChange={(e) => setPick(e.target.value)}
            >
              <option value="">Grant access to…</option>
              {ungranted.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.displayName || p.id}
                </option>
              ))}
            </select>
            <button
              className="chip"
              disabled={busy || !pick}
              onClick={() => {
                onGrant(pick);
                setPick("");
              }}
            >
              Grant
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function AuditList({ snap }: { snap: AccessSnapshot }) {
  if (!snap.events.length) {
    return <p className="panel p-4 text-sm text-[var(--muted)]">Nothing recorded yet.</p>;
  }
  return (
    <div className="panel divide-y divide-[var(--border)]">
      {snap.events.map((e) => (
        <div key={e.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 p-3">
          <span
            className={`mono text-xs ${
              e.event ==="auth.denied" ?"text-[var(--danger)]" :"text-[var(--text-soft)]"
            }`}
          >
            {e.event}
          </span>
          <span className="mono text-xs text-[var(--muted)]">
            {shortDate(e.at)}
            {e.source ?` · ${e.source}` :""}
            {e.principalId ?` · ${e.principalId}` :""}
            {e.actor ?` · by ${e.actor}` :""}
          </span>
          {Object.keys(e.detail).length > 0 && (
            <span className="mono min-w-0 flex-1 truncate text-xs text-[var(--muted)]">
              {JSON.stringify(e.detail)}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

function RolePicker({
  roles,
  setRoles,
}: {
  roles: string[];
  setRoles: (r: string[]) => void;
}) {
  return (
    <div className="mt-3">
      <div className="mb-1 text-xs text-[var(--muted)]">Roles</div>
      <div className="flex flex-wrap gap-2">
        {ROLES.map((r) => {
          const on = roles.includes(r);
          return (
            <button
              key={r}
              type="button"
              aria-pressed={on}
              onClick={() => setRoles(on ? roles.filter((x) => x !== r) : [...roles, r])}
              className={`chip ${on ?"border-transparent bg-[var(--brand-soft)] text-[var(--positive)]" :""}`}
            >
              {r}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  required,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  required?: boolean;
}) {
  return (
    <label className="block">
      <div className="mb-1 text-xs text-[var(--muted)]">{label}</div>
      <input
        className="field"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        required={required}
      />
    </label>
  );
}

function SectionHeading({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="mb-3">
      <h2 className="text-sm font-semibold">{title}</h2>
      <p className="mt-0.5 text-sm text-[var(--muted)]">{subtitle}</p>
    </div>
  );
}

function shortDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    month:"short",
    day:"numeric",
    hour:"2-digit",
    minute:"2-digit",
  });
}
