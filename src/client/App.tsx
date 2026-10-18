import { useEffect, useRef, useState, type ReactNode } from "react";
import { Banner, Button, Column, Dialog, Heading, Input, NavItem, PasswordInput, Row, SmartLink, Switch, Table, Tag, Text } from "@once-ui-system/core";
import { api, displayTime, setCsrf, type AuthStatus } from "./api.ts";
import { AppSelect } from "./AppSelect.tsx";

type Connection = {
  id: number; kind: "sonarr" | "radarr"; name: string; url: string; callback_url: string; enabled: number;
  policy_mode: "allow" | "block"; languages: string[]; scan_enabled: number; scan_interval_hours: number;
  on_import: number; on_upgrade: number; stall_enabled: number; torrent_timeout_min: number; usenet_timeout_min: number;
  next_scan_at?: string | null; webhook_notification_id?: number | null; hasApiKey: boolean;
};
type CleanupTarget = { id: number; name: string; path: string; enabled: number; interval_hours: number; next_run_at?: string | null };
type Activity = { id: number; kind: string; status: string; message: string; created_at: string; connection_id?: number; job_id?: number };
type Job = { id: number; kind: string; state: string; created_at: string; finished_at?: string; error?: string };
type MediaApplyJob = Job & { total: number; completed: number; succeeded: number; failed: number; outcomes: Array<{ status: string; message: string; created_at: string }> };
type PreviewRow = { connectionId: number; file: { id: number; path?: string; size?: number }; audio: string[]; status: "pass" | "fail" | "review"; reason: string; releaseTitle?: string };
type LogRow = { id: number; level: string; message: string; connection_id?: number; job_id?: number; created_at: string; details?: string };

function Panel({ title, children, action }: { title?: string; children: ReactNode; action?: ReactNode }) {
  return <Column background="surface" border radius="l" padding="24" gap="16" fillWidth>
    {title && <Row fillWidth horizontal="between" vertical="center" gap="12"><Heading as="h2" variant="display-strong-xs">{title}</Heading>{action}</Row>}
    {children}
  </Column>;
}
function StateTag({ value }: { value: string }) {
  const scheme = value === "done" || value === "pass" ? "success" : value === "fail" || value === "error" || value === "failed" ? "danger" : value === "review" || value === "warning" ? "warning" : "info";
  return <Tag scheme={scheme}>{value}</Tag>;
}
function Notice({ message, kind = "info" }: { message?: string; kind?: "info" | "error" }) {
  if (!message) return null;
  return <Text variant="body-default-s" onBackground={kind === "error" ? "danger-medium" : "brand-medium"}>{message}</Text>;
}

function AuthPage({ mustChangeCredentials, onSuccess }: { mustChangeCredentials: boolean; onSuccess: (auth: AuthStatus) => void }) {
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try {
      const result = await api<{ username: string; csrf: string; mustChangeCredentials: boolean }>("/auth/login", "POST", { username, password });
      setCsrf(result.csrf);
      onSuccess({ authenticated: true, username: result.username, csrf: result.csrf, mustChangeCredentials: result.mustChangeCredentials });
    } catch (issue) { setError(String(issue instanceof Error ? issue.message : issue)); }
    finally { setBusy(false); }
  }
  return <Column className="auth-shell" fillWidth>
    {mustChangeCredentials && <Banner className="credentials-banner" solid="warning-medium" onSolid="warning-strong" paddingY="8">
      Default login is active. Sign in and set your own credentials in Settings.
    </Banner>}
    <Column as="main" className="auth-main" fillWidth center padding="24">
      <Column maxWidth="s" background="surface" border radius="xl" padding="32" gap="24">
        <Column gap="8"><Text variant="label-default-s" onBackground="brand-medium">ARRBITER</Text>
          <Heading as="h1" variant="display-strong-s">Welcome back</Heading>
          <Text variant="body-default-s" onBackground="neutral-weak">Sign in to manage your media rules and downloads. On a new installation, use admin / arrbiter.</Text>
        </Column>
        <form onSubmit={submit}><Column gap="16">
          <Input id="username" label="Username" value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" required focusRing />
          <PasswordInput id="password" label="Password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" required focusRing />
          <Notice message={error} kind="error" /><Button type="submit" fillWidth loading={busy}>Sign in</Button>
        </Column></form>
      </Column>
    </Column>
  </Column>;
}

const nav = [
  { href: "/", label: "Dashboard", icon: "home" as const },
  { href: "/library", label: "Library", icon: "book" as const },
  { href: "/activity", label: "Activity", icon: "inbox" as const },
  { href: "/logs", label: "Logs", icon: "code" as const },
  { href: "/settings", label: "Settings", icon: "settings" as const },
];

function Shell({ username, mustChangeCredentials, children, onLogout }: { username?: string; mustChangeCredentials: boolean; children: ReactNode; onLogout: () => void }) {
  const path = window.location.pathname;
  return <Column fill className="app-shell">
    {mustChangeCredentials && <Banner className="credentials-banner" solid="warning-medium" onSolid="warning-strong" paddingY="8" wrap>
      <Text variant="label-default-s">You are using the default login. Set your own password in Settings.</Text>
      <Button size="s" variant="secondary" href="/settings">Change credentials</Button>
    </Banner>}
    <Row className="app-header" fillWidth horizontal="between" vertical="center" paddingX="20" borderBottom>
      <Row gap="12" vertical="center"><Text variant="heading-strong-m">Arrbiter</Text><Tag scheme="brand">Media control</Tag></Row>
      <Row gap="12" vertical="center"><Text variant="label-default-s" onBackground="neutral-weak">{username}</Text><Button size="s" variant="tertiary" onClick={onLogout}>Sign out</Button></Row>
      <Row className="nav-mobile" gap="8" paddingY="8">{nav.map((item) => <Button key={item.href} size="s" variant={path === item.href ? "secondary" : "tertiary"} href={item.href}>{item.label}</Button>)}</Row>
    </Row>
    <Row fill className="app-pane" paddingX="8" gap="8">
      <Column className="sidebar" width={18} fitHeight position="sticky" top="56" paddingY="20" gap="4">
        {nav.map((item) => <NavItem key={item.href} href={item.href} label={item.label} icon={item.icon} selected={path === item.href} size="l" radius="m" />)}
      </Column>
      <Column className="content" fillWidth background="surface" topRadius="l" padding="32" gap="24" overflowY="auto">
        {children}
      </Column>
    </Row>
  </Column>;
}

function Dashboard() {
  const [data, setData] = useState<{ connections: Connection[]; targets: CleanupTarget[]; idleSince: string | null; counts: { pendingJobs: number; reviews: number }; recentActivity: Activity[] }>();
  const [error, setError] = useState("");
  useEffect(() => { api<typeof data>("/dashboard").then((value) => setData(value)).catch((issue) => setError(String(issue))); }, []);
  return <Column gap="24" fillWidth>
    <Column gap="8"><Text variant="label-default-s" onBackground="brand-medium">OVERVIEW</Text><Heading as="h1" variant="display-strong-s">Dashboard</Heading><Text onBackground="neutral-weak">Connection health, active work, and recent decisions.</Text></Column>
    <Notice message={error} kind="error" />
    <div className="metric-grid">
      {[["Connections", data?.connections.filter((item) => item.enabled).length ?? "—"], ["Pending jobs", data?.counts.pendingJobs ?? "—"], ["Review items", data?.counts.reviews ?? "—"], ["Cleanup folders", data?.targets.filter((item) => item.enabled).length ?? "—"]].map(([label, value]) =>
        <Panel key={label}><Text variant="label-default-s" onBackground="neutral-weak">{label}</Text><Heading as="h2" variant="display-strong-s">{value}</Heading></Panel>) }
    </div>
    <Panel title="Connections" action={<Button size="s" variant="secondary" href="/settings">Manage</Button>}>
      {!data?.connections.length ? <Text onBackground="neutral-weak">Add a Sonarr or Radarr connection to begin.</Text> :
        <div className="table-wrap"><Table compact data={{ headers: [{ content: "Name", key: "name" }, { content: "Type", key: "type" }, { content: "Policy", key: "policy" }, { content: "Status", key: "status" }], rows: data.connections.map((item) => [item.name, item.kind, `${item.policy_mode} · ${item.languages.length} languages`, <StateTag value={item.enabled ? "active" : "disabled"} />]) }} /></div>}
    </Panel>
    <Panel title="Recent activity" action={<Button size="s" variant="secondary" href="/activity">View all</Button>}>
      <Text variant="body-default-s" onBackground="neutral-weak">All instances idle since: {displayTime(data?.idleSince)}</Text>
      {!data?.recentActivity.length ? <Text onBackground="neutral-weak">No activity yet.</Text> : data.recentActivity.map((item) =>
        <Row key={item.id} fillWidth horizontal="between" gap="12" borderBottom paddingY="8"><Column gap="4"><Text>{item.message}</Text><Text variant="label-default-s" onBackground="neutral-weak">{displayTime(item.created_at)}</Text></Column><StateTag value={item.status} /></Row>)}
    </Panel>
  </Column>;
}

function Library() {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [selected, setSelected] = useState("");
  const [preview, setPreview] = useState<{ id: string; rows: PreviewRow[] }>();
  const [decisionFilter, setDecisionFilter] = useState<"all" | PreviewRow["status"]>("all");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [activeJobId, setActiveJobId] = useState<number | null>(() => {
    const requested = Number(new URLSearchParams(window.location.search).get("jobId"));
    const stored = Number(window.sessionStorage.getItem("arrbiter-media-apply-job"));
    return Number.isInteger(requested) && requested > 0 ? requested : Number.isInteger(stored) && stored > 0 ? stored : null;
  });
  const [job, setJob] = useState<MediaApplyJob>();
  const [jobError, setJobError] = useState("");
  const resultsRef = useRef<HTMLDivElement>(null);
  const followResultsRef = useRef(true);
  useEffect(() => { api<Connection[]>("/connections").then((rows) => { setConnections(rows); if (rows.length) setSelected(String(rows[0].id)); }).catch((issue) => setError(String(issue))); }, []);
  useEffect(() => { followResultsRef.current = true; }, [activeJobId]);
  useEffect(() => {
    if (resultsRef.current && followResultsRef.current) resultsRef.current.scrollTop = resultsRef.current.scrollHeight;
  }, [job?.outcomes.length]);
  useEffect(() => {
    if (!activeJobId) return;
    let cancelled = false;
    const refresh = async () => {
      try {
        const current = await api<MediaApplyJob>(`/jobs/${activeJobId}`);
        if (cancelled) return;
        setJob(current); setJobError("");
        if (current.state === "done" || current.state === "failed") clearInterval(timer);
      } catch (issue) { if (!cancelled) setJobError(String(issue)); }
    };
    const timer = setInterval(() => void refresh(), 2_000);
    void refresh();
    return () => { cancelled = true; clearInterval(timer); };
  }, [activeJobId]);
  async function runPreview() {
    setBusy(true); setError("");
    try {
      const next = await api<{ id: string; rows: PreviewRow[] }>(`/connections/${selected}/preview`, "POST");
      setPreview(next); setDecisionFilter("all"); setActiveJobId(null); setJob(undefined); setJobError("");
      window.sessionStorage.removeItem("arrbiter-media-apply-job");
      window.history.replaceState(null, "", "/library");
    } catch (issue) { setError(String(issue)); }
    finally { setBusy(false); }
  }
  async function apply() {
    if (!preview) return;
    setBusy(true); setError("");
    try {
      const result = await api<{ jobId: number }>(`/previews/${preview.id}/apply`, "POST");
      window.sessionStorage.setItem("arrbiter-media-apply-job", String(result.jobId));
      window.history.replaceState(null, "", `/library?jobId=${result.jobId}`);
      setJob(undefined); setActiveJobId(result.jobId);
    } catch (issue) { setError(String(issue)); }
    finally { setBusy(false); }
  }
  const failures = preview?.rows.filter((row) => row.status === "fail").length || 0;
  const visibleRows = preview?.rows.filter((row) => decisionFilter === "all" || row.status === decisionFilter) || [];
  const decisionOptions = [
    { value: "all", label: `All decisions (${preview?.rows.length || 0})` },
    { value: "pass", label: `Pass (${preview?.rows.filter((row) => row.status === "pass").length || 0})` },
    { value: "fail", label: `Fail (${failures})` },
    { value: "review", label: `Review (${preview?.rows.filter((row) => row.status === "review").length || 0})` },
  ];
  return <Column gap="24" fillWidth>
    <Column gap="8"><Text variant="label-default-s" onBackground="brand-medium">MEDIA</Text><Heading as="h1" variant="display-strong-s">Library scan</Heading><Text onBackground="neutral-weak">Preview audio-language decisions before a manual scan removes files.</Text></Column>
    <Panel title="Run a scan"><Row gap="12" vertical="end" wrap><AppSelect id="scan-connection" label="Connection" value={selected} onSelect={(value) => { setSelected(value); setPreview(undefined); setDecisionFilter("all"); }} options={connections.map((item) => ({ label: `${item.name} (${item.kind})`, value: String(item.id) }))} /><Button onClick={runPreview} disabled={!selected || Boolean(activeJobId && (!job || job.state === "queued" || job.state === "running"))} loading={busy}>Preview scan</Button></Row>
      {connections.find((item) => String(item.id) === selected)?.enabled === 0 && <Text variant="body-default-s" onBackground="neutral-weak">Automatic checks are off for this connection. Preview and Apply still run when you choose them.</Text>}
      <Notice message={error} kind="error" /></Panel>
    {activeJobId && <Panel title={`Apply job #${activeJobId}`} action={<Button size="s" variant="secondary" href={`/logs?jobId=${activeJobId}`}>View logs</Button>}>
      <div aria-live="polite"><Row gap="12" vertical="center" wrap><StateTag value={job?.state || "queued"} /><Text>{job ? job.state === "failed" && job.completed === 0
        ? `No files processed · ${job.total} planned`
        : `${job.completed} of ${job.total} checked · ${job.succeeded} removed · ${job.failed} file errors` : "Loading job progress…"}</Text></Row></div>
      {job?.state === "failed" && <Notice message={job.error || "The job failed. Review the file results below."} kind="error" />}
      {job?.state === "done" && <Text variant="body-default-s" onBackground="success-medium">Apply finished. Run a new preview to see the current library.</Text>}
      <Notice message={jobError} kind="error" />
      <Text variant="label-default-s" onBackground="neutral-weak">File results · {job?.outcomes.length || 0}</Text>
      <Column ref={resultsRef} fillWidth height="42dvh" maxHeight={22} overflowY="auto" background="neutral-alpha-weak" border radius="m" paddingX="12" role="region" aria-label="File processing results" tabIndex={0}
        onScroll={(event) => { const element = event.currentTarget; followResultsRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 32; }}>
        {!job?.outcomes.length ? <Text paddingY="12" variant="body-default-s" onBackground="neutral-weak">Waiting for file results…</Text> : job.outcomes.map((outcome, index) =>
          <Row key={`${index}:${outcome.created_at}`} fillWidth horizontal="between" vertical="start" gap="12" borderBottom paddingY="8">
            <Text className="apply-result-message" variant="body-default-s">{outcome.message}</Text><StateTag value={outcome.status} />
          </Row>)}
      </Column>
      <SmartLink href="/activity">Open Activity</SmartLink>
    </Panel>}
    {preview && <Panel title={`Preview · ${preview.rows.length} files`} action={<Button variant="danger" onClick={apply} disabled={!failures || busy || Boolean(activeJobId)} loading={busy}>Apply all {failures} failed files</Button>}>
      <Text variant="body-default-s" onBackground="neutral-weak">Only failed files with an identified release can be removed. Apply processes all failures in this preview, regardless of the filter. Every file is rechecked before action.</Text>
      {activeJobId && <Text variant="body-default-s" onBackground="neutral-weak">This preview has been applied. Run a new preview before applying again.</Text>}
      <Row fillWidth vertical="end" gap="16" wrap>
        <Column className="decision-filter"><AppSelect id="decision-filter" label="Decision" value={decisionFilter} options={decisionOptions} onSelect={(value) => setDecisionFilter(value as typeof decisionFilter)} /></Column>
        <Text variant="body-default-s" onBackground="neutral-weak">Decision filter: {visibleRows.length} of {preview.rows.length} files</Text>
      </Row>
      {visibleRows.length ? <div className="table-wrap"><Table key={`${preview.id}:${decisionFilter}`} paginated defaultPageSize={20} searchable data={{ headers: [{ content: "File", key: "file" }, { content: "Audio", key: "audio" }, { content: "Decision", key: "decision" }, { content: "Reason", key: "reason" }], rows: visibleRows.map((row) => [<span className="mono">{row.file.path || row.file.id}</span>, row.audio.join(", ") || "Unknown", <StateTag value={row.status} />, row.reason]) }} /></div> : <Text onBackground="neutral-weak">No files match this decision.</Text>}
    </Panel>}
  </Column>;
}

function ActivityPage() {
  const [activity, setActivity] = useState<Activity[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    const load = () => Promise.all([api<Activity[]>("/activity"), api<Job[]>("/jobs")]).then(([a, j]) => { setActivity(a); setJobs(j); }).catch((issue) => setError(String(issue)));
    void load(); const timer = setInterval(load, 10_000); return () => clearInterval(timer);
  }, []);
  return <Column gap="24" fillWidth><Column gap="8"><Text variant="label-default-s" onBackground="brand-medium">JOBS</Text><Heading as="h1" variant="display-strong-s">Activity</Heading><Text onBackground="neutral-weak">Scans, downloads, cleanup, and actions needing review.</Text></Column><Notice message={error} kind="error" />
    <Panel title="Jobs"><div className="table-wrap"><Table paginated defaultPageSize={10} data={{ headers: [{ content: "Job", key: "id" }, { content: "Type", key: "kind" }, { content: "State", key: "state" }, { content: "Started", key: "time" }, { content: "Details", key: "details" }], rows: jobs.map((job) => [<SmartLink href={job.kind === "media-apply" ? `/library?jobId=${job.id}` : `/logs?jobId=${job.id}`}>#{job.id}</SmartLink>, job.kind, <StateTag value={job.state} />, displayTime(job.created_at), job.error || "—"]) }} /></div></Panel>
    <Panel title="Decisions"><div className="table-wrap"><Table paginated defaultPageSize={20} searchable data={{ headers: [{ content: "Time", key: "time" }, { content: "Type", key: "type" }, { content: "Status", key: "status" }, { content: "Message", key: "message" }], rows: activity.map((item) => [displayTime(item.created_at), item.kind, <StateTag value={item.status} />, <SmartLink href={item.job_id ? `/logs?jobId=${item.job_id}` : "/logs"}>{item.message}</SmartLink>]) }} /></div></Panel>
  </Column>;
}

const intervals = [{ value: "6", label: "Every 6 hours" }, { value: "12", label: "Every 12 hours" }, { value: "24", label: "Every 24 hours" }, { value: "168", label: "Weekly" }];

function ConnectionEditor({ current, suggestedCallbackUrl, onSaved, onCancel }: { current?: Connection; suggestedCallbackUrl: string; onSaved: () => void; onCancel: () => void }) {
  const [name, setName] = useState(current?.name || "");
  const [kind, setKind] = useState<"sonarr" | "radarr">(current?.kind || "sonarr");
  const [url, setUrl] = useState(current?.url || "");
  const [apiKey, setApiKey] = useState("");
  const [callbackUrl, setCallbackUrl] = useState(current?.callback_url || suggestedCallbackUrl);
  const [enabled, setEnabled] = useState(Boolean(current?.enabled));
  const [mode, setMode] = useState<"allow" | "block">(current?.policy_mode || "allow");
  const [selected, setSelected] = useState<string[]>(current?.languages || []);
  const [search, setSearch] = useState("");
  const [suggestions, setSuggestions] = useState<Array<{ code: string; name: string }>>([]);
  const [scanEnabled, setScanEnabled] = useState(Boolean(current?.scan_enabled));
  const [scanInterval, setScanInterval] = useState(String(current?.scan_interval_hours || 24));
  const [onImport, setOnImport] = useState(current ? Boolean(current.on_import) : true);
  const [onUpgrade, setOnUpgrade] = useState(current ? Boolean(current.on_upgrade) : true);
  const [stallEnabled, setStallEnabled] = useState(Boolean(current?.stall_enabled));
  const [torrentTimeout, setTorrentTimeout] = useState(String(current?.torrent_timeout_min || 1440));
  const [usenetTimeout, setUsenetTimeout] = useState(String(current?.usenet_timeout_min || 360));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  useEffect(() => {
    if (search.trim().length < 2) { setSuggestions([]); return; }
    const timer = setTimeout(() => { api<Array<{ code: string; name: string }>>(`/languages?q=${encodeURIComponent(search)}`).then(setSuggestions).catch(() => setSuggestions([])); }, 200);
    return () => clearTimeout(timer);
  }, [search]);
  async function test() {
    setBusy(true); setMessage("");
    try {
      const callbackSettings = { callbackUrl, enabled, onImport, onUpgrade };
      const result = current && !apiKey
        ? await api<{ version?: string }>(`/connections/${current.id}/test`, "POST", callbackSettings)
        : await api<{ version?: string }>("/connections/test", "POST", { kind, url, apiKey, ...callbackSettings });
      setMessage(`${kind === "sonarr" ? "Sonarr" : "Radarr"} API reachable${result.version ? ` · version ${result.version}` : ""}. Webhook delivery is checked when you save an active connection.`);
    } catch (issue) { setMessage(String(issue)); }
    finally { setBusy(false); }
  }
  async function save() {
    setBusy(true); setMessage("");
    try {
      await api(current ? `/connections/${current.id}` : "/connections", current ? "PUT" : "POST", {
        name, kind, url, apiKey, callbackUrl, enabled, policyMode: mode, languages: selected,
        scanEnabled, scanIntervalHours: Number(scanInterval), onImport, onUpgrade, stallEnabled,
        torrentTimeoutMin: Number(torrentTimeout), usenetTimeoutMin: Number(usenetTimeout),
      });
      onSaved();
    } catch (issue) { setMessage(String(issue)); }
    finally { setBusy(false); }
  }
  return <Dialog open background="surface" title={current ? `Edit ${current.name}` : "Add connection"} description="Connect Sonarr or Radarr and configure its media rules." closeOnClickaway={false} onClose={() => { if (!busy) onCancel(); }} footer={<Column gap="8" fillWidth>
    <Notice message={message} kind={message.startsWith("Error") ? "error" : "info"} />
    <Row gap="8" wrap><Button onClick={save} loading={busy}>Save connection</Button><Button variant="secondary" onClick={test} loading={busy}>Test connection</Button><Button variant="tertiary" onClick={onCancel} disabled={busy}>Cancel</Button></Row>
  </Column>}>
    <Column gap="20" fillWidth>
      <div className="field-grid">
        <Input id="connection-name" label="Name" value={name} onChange={(event) => setName(event.target.value)} focusRing />
        <AppSelect id="connection-kind" label="Application" value={kind} options={[{ value: "sonarr", label: "Sonarr" }, { value: "radarr", label: "Radarr" }]} onSelect={(value) => setKind(value as "sonarr" | "radarr")} />
        <Input id="connection-url" label="Sonarr/Radarr URL" placeholder="http://sonarr:8989" value={url} onChange={(event) => setUrl(event.target.value)} focusRing />
        <PasswordInput id="connection-key" label={current ? "API key (leave blank to keep)" : "API key"} value={apiKey} onChange={(event) => setApiKey(event.target.value)} focusRing />
        <Input id="callback-url" label="Arrbiter URL reachable by this instance" placeholder="http://<this-PC-LAN-IP>:8788" value={callbackUrl} onChange={(event) => setCallbackUrl(event.target.value)} description="For another machine, use this PC's LAN address with webhook port 8788. localhost points to the Sonarr/Radarr machine itself." focusRing />
      </div>
      {suggestedCallbackUrl && callbackUrl !== suggestedCallbackUrl && <Row><Button size="s" variant="tertiary" onClick={() => setCallbackUrl(suggestedCallbackUrl)}>Use working webhook address: {suggestedCallbackUrl}</Button></Row>}
      <Row gap="12" vertical="center"><Switch checked={enabled} onToggle={() => setEnabled(!enabled)} ariaLabel="Enable connection" /><Text>Activate connection</Text></Row>
      <Column gap="12"><Heading as="h3" variant="heading-strong-m">Audio-language rule</Heading>
        <AppSelect id="policy-mode" label="Rule mode" value={mode} options={[{ value: "allow", label: "Allowlist · keep if any selected language is present" }, { value: "block", label: "Blocklist · remove if any selected language is present" }]} onSelect={(value) => setMode(value as "allow" | "block")} />
        <Input id="language-search" label="Find a language" placeholder="Search by name or ISO code" value={search} onChange={(event) => setSearch(event.target.value)} focusRing />
        {suggestions.length > 0 && <Row wrap gap="8">{suggestions.slice(0, 20).map((item) => <Button key={item.code} size="s" variant="secondary" onClick={() => { if (!selected.includes(item.code)) setSelected([...selected, item.code]); setSearch(""); }}>{item.name} · {item.code}</Button>)}</Row>}
        <Row wrap gap="8">{selected.map((code) => <Button key={code} size="s" variant="tertiary" onClick={() => setSelected(selected.filter((item) => item !== code))}>{code} ×</Button>)}</Row>
      </Column>
      <Column gap="12"><Heading as="h3" variant="heading-strong-m">New media and scheduled scans</Heading>
        <Row wrap gap="20" vertical="center"><Row gap="8" vertical="center"><Switch checked={onImport} onToggle={() => setOnImport(!onImport)} ariaLabel="Check new imports" /><Text>Check new imports</Text></Row><Row gap="8" vertical="center"><Switch checked={onUpgrade} onToggle={() => setOnUpgrade(!onUpgrade)} ariaLabel="Check upgrades" /><Text>Check upgrades</Text></Row></Row>
        <Row gap="12" vertical="center"><Switch checked={scanEnabled} onToggle={() => setScanEnabled(!scanEnabled)} ariaLabel="Scheduled library scan" /><Text>Scheduled library scan</Text></Row>
        <AppSelect id="scan-interval" label="Scan interval" value={scanInterval} options={intervals} onSelect={setScanInterval} />
      </Column>
      <Column gap="12"><Heading as="h3" variant="heading-strong-m">Stalled downloads</Heading>
        <Row gap="12" vertical="center"><Switch checked={stallEnabled} onToggle={() => setStallEnabled(!stallEnabled)} ariaLabel="Remove stalled downloads" /><Text>Remove, blocklist, and replace stalled downloads</Text></Row>
        <div className="field-grid"><Input id="torrent-timeout" type="number" min={30} max={10080} label="Torrent timeout · minutes" value={torrentTimeout} onChange={(event) => setTorrentTimeout(event.target.value)} focusRing /><Input id="usenet-timeout" type="number" min={30} max={10080} label="Usenet timeout · minutes" value={usenetTimeout} onChange={(event) => setUsenetTimeout(event.target.value)} focusRing /></div>
        <Text variant="body-default-s" onBackground="neutral-weak">Only actively downloading items with no byte progress for the full interval are removed. Range: 30 minutes to 7 days.</Text>
      </Column>
    </Column>
  </Dialog>;
}

function TargetEditor({ current, onSaved, onCancel }: { current?: CleanupTarget; onSaved: () => void; onCancel: () => void }) {
  const [name, setName] = useState(current?.name || "");
  const [path, setPath] = useState(current?.path || "/cleanup/");
  const [interval, setIntervalValue] = useState(String(current?.interval_hours || 24));
  const [enabled, setEnabled] = useState(Boolean(current?.enabled));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  async function save() {
    setBusy(true); setMessage("");
    try { await api(current ? `/cleanup-targets/${current.id}` : "/cleanup-targets", current ? "PUT" : "POST", { name, path, intervalHours: Number(interval), enabled }); onSaved(); }
    catch (issue) { setMessage(String(issue)); }
    finally { setBusy(false); }
  }
  return <Dialog open background="surface" title={current ? `Edit ${current.name}` : "Add cleanup folder"} description="Schedule cleanup for a disposable download folder." closeOnClickaway={false} onClose={() => { if (!busy) onCancel(); }} footer={<Column gap="8" fillWidth>
    <Notice message={message} kind="error" />
    <Row gap="8" wrap><Button onClick={save} loading={busy}>Save folder</Button><Button variant="tertiary" onClick={onCancel} disabled={busy}>Cancel</Button></Row>
  </Column>}><Column gap="16" fillWidth>
    <Text variant="body-default-s" onBackground="neutral-weak">Use only a dedicated disposable folder mounted below /cleanup. Its contents are deleted after all connected instances stay idle for 30 minutes.</Text>
    <div className="field-grid"><Input id="target-name" label="Name" value={name} onChange={(event) => setName(event.target.value)} focusRing /><Input id="target-path" label="Path inside Arrbiter" value={path} onChange={(event) => setPath(event.target.value)} focusRing /><AppSelect id="cleanup-interval" label="Cleanup interval" value={interval} options={intervals} onSelect={setIntervalValue} /></div>
    <Row gap="12" vertical="center"><Switch checked={enabled} onToggle={() => setEnabled(!enabled)} ariaLabel="Enable cleanup" /><Text>Activate scheduled cleanup</Text></Row>
  </Column></Dialog>;
}

function SettingsPage({ username, onCredentialsChanged }: { username: string; onCredentialsChanged: (username: string) => void }) {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [targets, setTargets] = useState<CleanupTarget[]>([]);
  const [editConnection, setEditConnection] = useState<Connection | null | "new">(null);
  const [editTarget, setEditTarget] = useState<CleanupTarget | null | "new">(null);
  const [cleanupPreview, setCleanupPreview] = useState<{ id: string; entries: number; bytes: number; sample: Array<{ path: string }> }>();
  const [message, setMessage] = useState("");
  const [nextUsername, setNextUsername] = useState(username);
  const [currentPassword, setCurrentPassword] = useState("");
  const [nextPassword, setNextPassword] = useState("");
  const browserHost = window.location.hostname;
  const suggestedCallbackUrl = connections.find((item) => item.enabled && item.callback_url)?.callback_url ||
    (!["localhost", "127.0.0.1", "::1"].includes(browserHost) && window.location.protocol === "http:" ? `http://${browserHost}:8788` : "");
  const refresh = () => Promise.all([api<Connection[]>("/connections"), api<CleanupTarget[]>("/cleanup-targets")]).then(([c, t]) => { setConnections(c); setTargets(t); });
  useEffect(() => { void refresh().catch((issue) => setMessage(String(issue))); }, []);
  async function removeConnection(id: number) {
    if (!window.confirm("Remove this connection and its Arrbiter webhook?")) return;
    try { await api(`/connections/${id}`, "DELETE"); await refresh(); }
    catch (issue) { setMessage(String(issue)); }
  }
  async function removeTarget(id: number) {
    if (!window.confirm("Remove this cleanup setting? Files will not be deleted.")) return;
    try { await api(`/cleanup-targets/${id}`, "DELETE"); await refresh(); }
    catch (issue) { setMessage(String(issue)); }
  }
  async function previewCleanup(id: number) {
    setMessage(""); setCleanupPreview(undefined);
    try { setCleanupPreview(await api(`/cleanup-targets/${id}/preview`, "POST")); }
    catch (issue) { setMessage(String(issue)); }
  }
  async function applyCleanupPreview() {
    if (!cleanupPreview || !window.confirm(`Delete the ${cleanupPreview.entries} previewed entries when the 30-minute idle check passes?`)) return;
    try { const result = await api<{ jobId: number }>(`/previews/${cleanupPreview.id}/apply`, "POST"); setMessage(`Cleanup job #${result.jobId} queued.`); setCleanupPreview(undefined); }
    catch (issue) { setMessage(String(issue)); }
  }
  async function changeCredentials() {
    try {
      const result = await api<{ username: string }>("/auth/credentials", "POST", { currentPassword, username: nextUsername, password: nextPassword });
      setCurrentPassword(""); setNextPassword(""); setNextUsername(result.username);
      onCredentialsChanged(result.username);
      setMessage("Login credentials updated.");
    }
    catch (issue) { setMessage(String(issue)); }
  }
  return <Column gap="24" fillWidth>
    <Column gap="8"><Text variant="label-default-s" onBackground="brand-medium">CONFIGURATION</Text><Heading as="h1" variant="display-strong-s">Settings</Heading><Text onBackground="neutral-weak">Connect your media managers, choose language rules, and control automatic work.</Text></Column>
    <Notice message={message} />
    <Panel title="Sonarr and Radarr" action={<Button size="s" onClick={() => setEditConnection("new")}>Add connection</Button>}>
      {!connections.length ? <Text onBackground="neutral-weak">No connections yet.</Text> : connections.map((item) => <Row key={item.id} fillWidth horizontal="between" vertical="center" gap="12" borderBottom paddingY="12" wrap>
        <Column gap="4"><Row gap="8" vertical="center"><Text variant="heading-strong-s">{item.name}</Text><StateTag value={item.enabled ? "active" : "disabled"} /></Row><Text variant="body-default-s" onBackground="neutral-weak">{item.kind} · {item.url} · {item.languages.length} language{item.languages.length === 1 ? "" : "s"}</Text></Column>
        <Row gap="8"><Button size="s" variant="secondary" onClick={() => setEditConnection(item)}>Edit</Button><Button size="s" variant="danger" onClick={() => removeConnection(item.id)}>Remove</Button></Row>
      </Row>)}
    </Panel>
    {editConnection && <ConnectionEditor key={editConnection === "new" ? "new" : editConnection.id} current={editConnection === "new" ? undefined : editConnection} suggestedCallbackUrl={suggestedCallbackUrl} onSaved={() => { setEditConnection(null); void refresh(); setMessage("Connection saved."); }} onCancel={() => setEditConnection(null)} />}
    <Panel title="Disposable download folders" action={<Button size="s" onClick={() => setEditTarget("new")}>Add folder</Button>}>
      {!targets.length ? <Text onBackground="neutral-weak">No cleanup folders configured.</Text> : targets.map((item) => <Row key={item.id} fillWidth horizontal="between" vertical="center" gap="12" borderBottom paddingY="12" wrap>
        <Column gap="4"><Row gap="8"><Text variant="heading-strong-s">{item.name}</Text><StateTag value={item.enabled ? "active" : "disabled"} /></Row><Text variant="body-default-s" onBackground="neutral-weak">{item.path} · next run {displayTime(item.next_run_at)}</Text></Column>
        <Row gap="8" wrap><Button size="s" variant="secondary" onClick={() => previewCleanup(item.id)}>Preview</Button><Button size="s" variant="secondary" onClick={() => setEditTarget(item)}>Edit</Button><Button size="s" variant="danger" onClick={() => removeTarget(item.id)}>Remove</Button></Row>
      </Row>)}
    </Panel>
    {cleanupPreview && <Panel title="Cleanup preview" action={<Button variant="danger" onClick={applyCleanupPreview} disabled={!cleanupPreview.entries}>Apply cleanup</Button>}>
      <Text>{cleanupPreview.entries} entries · {(cleanupPreview.bytes / 1024 / 1024).toFixed(1)} MiB</Text>
      <Text variant="body-default-s" onBackground="neutral-weak">The worker checks every connected instance is idle before deleting. New or changed files stay in place.</Text>
      <Column className="mono" gap="4">{cleanupPreview.sample.map((entry) => <Text key={entry.path} variant="body-default-xs">{entry.path}</Text>)}</Column>
    </Panel>}
    {editTarget && <TargetEditor key={editTarget === "new" ? "new" : editTarget.id} current={editTarget === "new" ? undefined : editTarget} onSaved={() => { setEditTarget(null); void refresh(); setMessage("Folder saved."); }} onCancel={() => setEditTarget(null)} />}
    <Panel title="Administrator credentials">
      <Text variant="body-default-s" onBackground="neutral-weak">Choose a password of at least 12 characters. Other sessions will be signed out.</Text>
      <div className="field-grid">
        <Input id="next-username" label="Username" value={nextUsername} onChange={(event) => setNextUsername(event.target.value)} autoComplete="username" />
        <PasswordInput id="current-password" label="Current password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} autoComplete="current-password" />
        <PasswordInput id="next-password" label="New password" value={nextPassword} onChange={(event) => setNextPassword(event.target.value)} autoComplete="new-password" />
      </div>
      <Row><Button onClick={changeCredentials}>Save credentials</Button></Row>
    </Panel>
  </Column>;
}

function LogsPage() {
  const query = new URLSearchParams(window.location.search);
  const [level, setLevel] = useState("");
  const [connectionId, setConnectionId] = useState("");
  const [jobId, setJobId] = useState(query.get("jobId") || "");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [rows, setRows] = useState<LogRow[]>([]);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [error, setError] = useState("");
  function params() {
    const q = new URLSearchParams();
    if (level) q.set("level", level);
    if (connectionId) q.set("connectionId", connectionId);
    if (jobId) q.set("jobId", jobId);
    if (from) q.set("from", new Date(from).toISOString());
    if (to) q.set("to", new Date(to).toISOString());
    return q;
  }
  useEffect(() => {
    api<Connection[]>("/connections").then(setConnections).catch(() => {});
    api<LogRow[]>(`/logs?${params()}`).then((data) => setRows(data.reverse())).catch((issue) => setError(String(issue)));
  }, [level, connectionId, jobId, from, to]);
  useEffect(() => {
    const events = new EventSource("/api/logs/stream");
    events.onmessage = (event) => {
      const item = JSON.parse(event.data) as LogRow & { connectionId?: number; jobId?: number; createdAt?: string };
      const normalized = { ...item, connection_id: item.connectionId, job_id: item.jobId, created_at: item.createdAt || item.created_at };
      if (level && normalized.level !== level) return;
      if (connectionId && String(normalized.connection_id) !== connectionId) return;
      if (jobId && String(normalized.job_id) !== jobId) return;
      setRows((previous) => [...previous.slice(-499), normalized]);
    };
    events.onerror = () => setError("Live stream disconnected; reconnecting…");
    events.onopen = () => setError("");
    return () => events.close();
  }, [level, connectionId, jobId]);
  function download(format: "text" | "jsonl") { window.location.href = `/api/logs/export?${params()}&format=${format}`; }
  return <Column gap="24" fillWidth>
    <Column gap="8"><Text variant="label-default-s" onBackground="brand-medium">DIAGNOSTICS</Text><Heading as="h1" variant="display-strong-s">Logs</Heading><Text onBackground="neutral-weak">Live Arrbiter events. API keys and tokens are redacted.</Text></Column>
    <Panel title="Live log" action={<Row gap="8"><Button size="s" variant="secondary" onClick={() => download("text")}>Export text</Button><Button size="s" variant="secondary" onClick={() => download("jsonl")}>Export JSONL</Button></Row>}>
      <div className="field-grid"><AppSelect id="log-level" label="Level" value={level} options={[{ value: "", label: "All levels" }, { value: "info", label: "Info" }, { value: "warn", label: "Warning" }, { value: "error", label: "Error" }]} onSelect={setLevel} />
        <AppSelect id="log-connection" label="Connection" value={connectionId} options={[{ value: "", label: "All connections" }, ...connections.map((item) => ({ value: String(item.id), label: item.name }))]} onSelect={setConnectionId} />
        <Input id="log-job" label="Job ID" value={jobId} onChange={(event) => setJobId(event.target.value)} />
        <label className="datetime-field" htmlFor="log-from">From<input id="log-from" type="datetime-local" value={from} onChange={(event) => setFrom(event.target.value)} /></label>
        <label className="datetime-field" htmlFor="log-to">To<input id="log-to" type="datetime-local" value={to} onChange={(event) => setTo(event.target.value)} /></label>
      </div>
      <Notice message={error} kind="error" />
      <div className="log-window" role="log" aria-live="polite">{rows.length ? rows.map((row) => <div key={row.id} className={`log-line ${row.level}`}>{displayTime(row.created_at)} [{row.level}] {row.message}</div>) : "No logs match these filters."}</div>
    </Panel>
  </Column>;
}

export default function App() {
  const [auth, setAuth] = useState<AuthStatus>();
  const [error, setError] = useState("");
  useEffect(() => { api<AuthStatus>("/auth/status").then((state) => { setAuth(state); setCsrf(state.csrf); }).catch((issue) => setError(String(issue))); }, []);
  async function logout() { await api("/auth/logout", "POST"); setCsrf(""); setAuth({ authenticated: false, mustChangeCredentials: auth?.mustChangeCredentials || false }); }
  if (error) return <Column padding="32"><Notice message={error} kind="error" /></Column>;
  if (!auth) return <Column padding="32"><Text>Loading Arrbiter…</Text></Column>;
  if (!auth.authenticated) return <AuthPage mustChangeCredentials={auth.mustChangeCredentials} onSuccess={setAuth} />;
  const path = window.location.pathname;
  return <Shell username={auth.username} mustChangeCredentials={auth.mustChangeCredentials} onLogout={logout}>
    {path === "/library" ? <Library /> : path === "/activity" ? <ActivityPage /> : path === "/logs" ? <LogsPage /> : path === "/settings" ? <SettingsPage username={auth.username || ""} onCredentialsChanged={(username) => setAuth((current) => current ? { ...current, username, mustChangeCredentials: false } : current)} /> : <Dashboard />}
  </Shell>;
}
