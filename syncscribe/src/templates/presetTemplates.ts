import { WikiDocument } from '../types/knowledge';

export const INITIAL_DOCUMENTS: WikiDocument[] = [
  // 1. Engineering Hub
  {
    id: 'rfc-104-event-mesh',
    workspaceId: 'ws-engineering',
    title: 'RFC-104: Distributed Event Mesh & Resilient Broker v2.4',
    icon: '⚡',
    category: 'Architecture RFCs',
    tags: ['Architecture', 'CRDT', 'RealTime', 'Distributed'],
    status: 'IN_REVIEW',
    updatedAt: '10 mins ago',
    author: 'Alex Chen',
    isStarred: true,
    description: 'High-throughput distributed event broker specification with partition tolerance and vector clock synchronization.',
  },
  {
    id: 'api-gateway-spec',
    workspaceId: 'ws-engineering',
    title: 'API Gateway Routing & Service Discovery Protocol',
    icon: '🌐',
    category: 'Architecture RFCs',
    tags: ['Backend', 'Microservices', 'Network'],
    status: 'COMPLETED',
    updatedAt: '2 hours ago',
    author: 'Devon Vance',
    isStarred: true,
    description: 'Dynamic upstream reverse proxy routing rules, canary deployment policies, and automatic circuit breaking.',
  },
  {
    id: 'security-zero-trust',
    workspaceId: 'ws-engineering',
    title: 'Zero-Trust Security & Identity Verification Baseline',
    icon: '🛡️',
    category: 'Security & Compliance',
    tags: ['Security', 'Auth', 'ZeroTrust', 'Compliance'],
    status: 'IN_PROGRESS',
    updatedAt: 'Yesterday',
    author: 'Maya Patel',
    isStarred: false,
    description: 'Mandatory cryptographic credential assertion, mutual TLS service mesh, and role-based lease management.',
  },

  // 2. Product Wiki
  {
    id: 'horizon-2027-roadmap',
    workspaceId: 'ws-product',
    title: 'Horizon 2027: Collaborative Platform Strategy',
    icon: '🚀',
    category: 'Roadmap & Strategy',
    tags: ['Product', 'Strategy', 'Roadmap', 'Horizon'],
    status: 'IN_PROGRESS',
    updatedAt: '3 hours ago',
    author: 'Elena Rostova',
    isStarred: true,
    description: 'Long-term product pillars, enterprise workspace collaboration, offline-first sync, and developer extensibility.',
  },
  {
    id: 'design-system-spec',
    workspaceId: 'ws-product',
    title: 'Aurora Design System v3.0 Guidelines & Tokens',
    icon: '🎨',
    category: 'Design & UX',
    tags: ['UI/UX', 'DesignSystem', 'Tokens', 'Tailwind'],
    status: 'COMPLETED',
    updatedAt: '1 day ago',
    author: 'Sarah Miller',
    isStarred: false,
    description: 'Universal typography hierarchies, accessible color contrast ratios, elevation tokens, and micro-interaction guidelines.',
  },

  // 3. Team Handbook
  {
    id: 'sprint-42-retro',
    workspaceId: 'ws-team',
    title: 'Sprint 42 Retrospective: Team Synergy & Velocity',
    icon: '🎯',
    category: 'Agile & Sprints',
    tags: ['Agile', 'Sprint', 'Retrospective', 'Velocity'],
    status: 'COMPLETED',
    updatedAt: 'May 14',
    author: 'Sarah Miller',
    isStarred: false,
    description: 'Sprint commitments retrospective, cycle-time achievements, root cause learnings, and key action commitments.',
  },
  {
    id: 'engineering-handbook',
    workspaceId: 'ws-team',
    title: 'Engineering Onboarding & Best Practices Handbook',
    icon: '📚',
    category: 'Guides & Onboarding',
    tags: ['Handbook', 'Onboarding', 'Culture', 'Workflow'],
    status: 'COMPLETED',
    updatedAt: '3 days ago',
    author: 'Alex Chen',
    isStarred: true,
    description: 'Everything a new engineer needs: local setup, PR lifecycle, deployment safety gates, and team values.',
  },

  // 4. Personal Vault
  {
    id: 'daily-standup-scratchpad',
    workspaceId: 'ws-notes',
    title: 'Daily Standup, Priority Matrix & Quick Notes',
    icon: '📝',
    category: 'Daily Scratchpad',
    tags: ['Notes', 'Standup', 'ToDos', 'Personal'],
    status: 'IN_PROGRESS',
    updatedAt: 'Just now',
    author: 'You',
    isStarred: true,
    description: 'Personal work in progress, blockers, quick brainstorming snippets, and prioritized to-do list.',
  },
];

export const PRESET_DOCUMENTS: Record<string, string> = {
  // Alias existing preset IDs
  'engineering-rfc': `
    <h1>RFC-104: Distributed Event Mesh & Resilient Broker v2.4</h1>
    <p>Status: <span data-type="status-badge" data-status="IN_REVIEW"></span> &nbsp; Lead Architect: <span data-type="collaborator-mention" data-name="Alex Chen" data-color="#3b82f6" data-role="Staff Architect"></span> &nbsp; Reviewer: <span data-type="collaborator-mention" data-name="Maya Patel" data-color="#ec4899" data-role="Security Engineer"></span></p>
    
    <div data-type="callout" data-callout-type="info">
      <p><strong>Architecture RFC Summary:</strong> This specification details our migration to a partition-tolerant, multi-region event mesh using Yjs CRDT synchronization and server-authoritative backpressure guarantees. Please submit comments before Friday.</p>
    </div>

    <div data-type="divider-with-label" data-label="SYSTEM ARCHITECTURE"></div>

    <h2>1. Core Broker Implementation</h2>
    <p>The synchronization layer maintains low latency updates while broadcasting state vector deltas over persistent WebSockets:</p>

    <pre data-type="custom-code-block" data-language="typescript"><code>interface EventEnvelope&lt;T&gt; {
  id: string;
  topic: string;
  timestamp: number;
  payload: T;
  vectorClock: Record&lt;string, number&gt;;
}

export class DistributedEventMesh {
  private peers = new Map&lt;string, WebSocket&gt;();

  async broadcastDelta(envelope: EventEnvelope&lt;Uint8Array&gt;): Promise&lt;void&gt; {
    const serialized = JSON.stringify(envelope);
    for (const [peerId, socket] of this.peers.entries()) {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(serialized);
      }
    }
  }
}</code></pre>

    <div data-type="divider-with-label" data-label="IMPLEMENTATION CHECKLIST"></div>

    <h2>2. Delivery Milestones & Readiness</h2>
    <ul data-type="taskList">
      <li data-type="taskItem" data-checked="true">Design deterministic Yjs binary frame protocol</li>
      <li data-type="taskItem" data-checked="true">Deploy awareness heartbeat with 15s timeout</li>
      <li data-type="taskItem" data-checked="false">Benchmark 10,000 concurrent client streams</li>
      <li data-type="taskItem" data-checked="false">Multi-region failover dry run with SRE team</li>
    </ul>

    <div data-type="callout" data-callout-type="warning">
      <p><strong>Security Notice:</strong> End-to-end token validation must be verified by <span data-type="collaborator-mention" data-name="Maya Patel" data-color="#ec4899" data-role="Security Engineer"></span> prior to staging deployment.</p>
    </div>
  `,

  'rfc-104-event-mesh': `
    <h1>RFC-104: Distributed Event Mesh & Resilient Broker v2.4</h1>
    <p>Status: <span data-type="status-badge" data-status="IN_REVIEW"></span> &nbsp; Lead Architect: <span data-type="collaborator-mention" data-name="Alex Chen" data-color="#3b82f6" data-role="Staff Architect"></span> &nbsp; Reviewer: <span data-type="collaborator-mention" data-name="Maya Patel" data-color="#ec4899" data-role="Security Engineer"></span></p>
    
    <div data-type="callout" data-callout-type="info">
      <p><strong>Architecture RFC Summary:</strong> This specification details our migration to a partition-tolerant, multi-region event mesh using Yjs CRDT synchronization and server-authoritative backpressure guarantees. Please submit comments before Friday.</p>
    </div>

    <div data-type="divider-with-label" data-label="SYSTEM ARCHITECTURE"></div>

    <h2>1. Core Broker Implementation</h2>
    <p>The synchronization layer maintains low latency updates while broadcasting state vector deltas over persistent WebSockets:</p>

    <pre data-type="custom-code-block" data-language="typescript"><code>interface EventEnvelope&lt;T&gt; {
  id: string;
  topic: string;
  timestamp: number;
  payload: T;
  vectorClock: Record&lt;string, number&gt;;
}

export class DistributedEventMesh {
  private peers = new Map&lt;string, WebSocket&gt;();

  async broadcastDelta(envelope: EventEnvelope&lt;Uint8Array&gt;): Promise&lt;void&gt; {
    const serialized = JSON.stringify(envelope);
    for (const [peerId, socket] of this.peers.entries()) {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(serialized);
      }
    }
  }
}</code></pre>

    <div data-type="divider-with-label" data-label="IMPLEMENTATION CHECKLIST"></div>

    <h2>2. Delivery Milestones & Readiness</h2>
    <ul data-type="taskList">
      <li data-type="taskItem" data-checked="true">Design deterministic Yjs binary frame protocol</li>
      <li data-type="taskItem" data-checked="true">Deploy awareness heartbeat with 15s timeout</li>
      <li data-type="taskItem" data-checked="false">Benchmark 10,000 concurrent client streams</li>
      <li data-type="taskItem" data-checked="false">Multi-region failover dry run with SRE team</li>
    </ul>

    <div data-type="callout" data-callout-type="warning">
      <p><strong>Security Notice:</strong> End-to-end token validation must be verified by <span data-type="collaborator-mention" data-name="Maya Patel" data-color="#ec4899" data-role="Security Engineer"></span> prior to staging deployment.</p>
    </div>
  `,

  'api-gateway-spec': `
    <h1>API Gateway Routing & Service Discovery Protocol</h1>
    <p>Status: <span data-type="status-badge" data-status="COMPLETED"></span> &nbsp; Owner: <span data-type="collaborator-mention" data-name="Devon Vance" data-color="#f59e0b" data-role="Infrastructure SRE"></span></p>

    <div data-type="callout" data-callout-type="success">
      <p><strong>Gateway Specification:</strong> Unified entry point for edge ingress, mTLS termination, rate limiting, and dynamic traffic canary split.</p>
    </div>

    <div data-type="divider-with-label" data-label="ROUTING TOPOLOGY"></div>
    <h2>1. Ingress Flow Specification</h2>
    <p>Incoming HTTP/2 and WebSocket connections terminate at the Envoy edge proxy before dispatching to internal services:</p>
    
    <pre data-type="custom-code-block" data-language="bash"><code># Health verification command
curl -v -H "Host: api.internal.network" https://edge-gateway.internal/healthz
# Expected output: HTTP/2 200 OK - upstream_healthy: true</code></pre>

    <h2>2. Deployment Safety Gates</h2>
    <ul data-type="taskList">
      <li data-type="taskItem" data-checked="true">Automated canary analysis enabled (5% -> 25% -> 100%)</li>
      <li data-type="taskItem" data-checked="true">Latency threshold alert set at p99 &gt; 45ms</li>
      <li data-type="taskItem" data-checked="true">Zero-downtime hot certificate reload verified</li>
    </ul>
  `,

  'security-zero-trust': `
    <h1>Zero-Trust Security & Identity Verification Baseline</h1>
    <p>Status: <span data-type="status-badge" data-status="IN_PROGRESS"></span> &nbsp; Security Lead: <span data-type="collaborator-mention" data-name="Maya Patel" data-color="#ec4899" data-role="Security Engineer"></span></p>

    <div data-type="callout" data-callout-type="danger">
      <p><strong>Strict Enforcement:</strong> All internal inter-service calls must include valid JWT assertions with ephemeral 15-minute lease cycles. Static bearer tokens are deprecated.</p>
    </div>

    <div data-type="divider-with-label" data-label="KEY PROTOCOLS"></div>
    <h2>1. Cryptographic Authentication Handshake</h2>
    <p>Clients obtain short-lived tokens via OIDC with hardware-bound keys before initiating any WebSocket room session.</p>

    <h2>2. Audit & Compliance Tasks</h2>
    <ul data-type="taskList">
      <li data-type="taskItem" data-checked="true">Audit all WebSocket connection endpoints for origin headers</li>
      <li data-type="taskItem" data-checked="false">Enforce SPIFFE ID validation on gRPC service mesh</li>
      <li data-type="taskItem" data-checked="false">Automated key rotation cron job with zero downtime</li>
    </ul>
  `,

  'horizon-2027-roadmap': `
    <h1>Horizon 2027: Collaborative Platform Strategy</h1>
    <p>Quarterly Horizon: <span data-type="status-badge" data-status="IN_PROGRESS"></span> &nbsp; Product Lead: <span data-type="collaborator-mention" data-name="Elena Rostova" data-color="#8b5cf6" data-role="Product Lead"></span></p>

    <div data-type="callout" data-callout-type="tip">
      <p><strong>Vision Statement:</strong> Elevate SyncScribe into an enterprise-grade collaborative workspace featuring zero-latency CRDTs, rich block extensions, and instant side-by-side peer verification.</p>
    </div>

    <div data-type="divider-with-label" data-label="KEY DELIVERABLES"></div>

    <h2>Core Initiatives by Pillar</h2>
    <ul data-type="taskList">
      <li data-type="taskItem" data-checked="true">Slash command palette with categorized search</li>
      <li data-type="taskItem" data-checked="true">Custom callout banners with 5 color themes</li>
      <li data-type="taskItem" data-checked="true">Live collaborator presence with custom avatar pigments</li>
      <li data-type="taskItem" data-checked="false">Offline-first local replica persistence</li>
      <li data-type="taskItem" data-checked="false">Enterprise SSO & Role-Based Access Control</li>
    </ul>

    <div data-type="divider-with-label" data-label="TARGET TIMELINE"></div>

    <div data-type="callout" data-callout-type="success">
      <p><strong>Beta Release Ahead of Schedule:</strong> The real-time synchronization engine achieved 99.98% sync reliability in testing with 0 merge conflicts observed.</p>
    </div>
  `,

  'product-roadmap': `
    <h1>Horizon 2027: Collaborative Platform Strategy</h1>
    <p>Quarterly Horizon: <span data-type="status-badge" data-status="IN_PROGRESS"></span> &nbsp; Product Lead: <span data-type="collaborator-mention" data-name="Elena Rostova" data-color="#8b5cf6" data-role="Product Lead"></span></p>

    <div data-type="callout" data-callout-type="tip">
      <p><strong>Vision Statement:</strong> Elevate SyncScribe into an enterprise-grade collaborative workspace featuring zero-latency CRDTs, rich block extensions, and instant side-by-side peer verification.</p>
    </div>

    <div data-type="divider-with-label" data-label="KEY DELIVERABLES"></div>

    <h2>Core Initiatives by Pillar</h2>
    <ul data-type="taskList">
      <li data-type="taskItem" data-checked="true">Slash command palette with categorized search</li>
      <li data-type="taskItem" data-checked="true">Custom callout banners with 5 color themes</li>
      <li data-type="taskItem" data-checked="true">Live collaborator presence with custom avatar pigments</li>
      <li data-type="taskItem" data-checked="false">Offline-first local replica persistence</li>
      <li data-type="taskItem" data-checked="false">Enterprise SSO & Role-Based Access Control</li>
    </ul>

    <div data-type="divider-with-label" data-label="TARGET TIMELINE"></div>

    <div data-type="callout" data-callout-type="success">
      <p><strong>Beta Release Ahead of Schedule:</strong> The real-time synchronization engine achieved 99.98% sync reliability in testing with 0 merge conflicts observed.</p>
    </div>
  `,

  'design-system-spec': `
    <h1>Aurora Design System v3.0 Guidelines & Tokens</h1>
    <p>Design Status: <span data-type="status-badge" data-status="COMPLETED"></span> &nbsp; Lead Designer: <span data-type="collaborator-mention" data-name="Sarah Miller" data-color="#10b981" data-role="Principal Engineer"></span></p>

    <div data-type="callout" data-callout-type="tip">
      <p><strong>Design Constitution:</strong> Every component must adhere to zero-pill discipline, high information density, semantic typography, and frictionless accessibility.</p>
    </div>

    <div data-type="divider-with-label" data-label="DESIGN TOKENS"></div>
    <h2>1. Elevation & Shadow Principles</h2>
    <p>Use discrete, calibrated shadows (shadow-xs, shadow-sm, shadow-md) with 2% opacity ambient rings rather than heavy colored dropshadows.</p>

    <h2>2. Component Checklist</h2>
    <ul data-type="taskList">
      <li data-type="taskItem" data-checked="true">Color tokens exported to Tailwind theme config</li>
      <li data-type="taskItem" data-checked="true">Focus-visible states audited for keyboard compliance</li>
      <li data-type="taskItem" data-checked="false">Dark mode contrast ratio &gt; 7:1 for all text bodies</li>
    </ul>
  `,

  'sprint-retro': `
    <h1>Sprint 42 Retrospective: Team Synergy & Velocity</h1>
    <p>Sprint Status: <span data-type="status-badge" data-status="COMPLETED"></span> &nbsp; Facilitator: <span data-type="collaborator-mention" data-name="Sarah Miller" data-color="#10b981" data-role="Principal Engineer"></span></p>

    <div data-type="callout" data-callout-type="success">
      <p><strong>Sprint Highlights:</strong> Team delivered 48 story points (target: 45). Zero Sev-1 incidents reported in production, and split-screen peer testing mode reduced QA validation time by 60%!</p>
    </div>

    <div data-type="divider-with-label" data-label="WHAT WENT WELL"></div>
    <ul data-type="taskList">
      <li data-type="taskItem" data-checked="true">Seamless WebSocket reconnection logic handled transient network drops</li>
      <li data-type="taskItem" data-checked="true">Interactive status badge cycling made task prioritization instantaneous</li>
      <li data-type="taskItem" data-checked="true">Markdown and HTML export proved popular with external stakeholders</li>
    </ul>

    <div data-type="divider-with-label" data-label="AREAS FOR IMPROVEMENT"></div>
    <div data-type="callout" data-callout-type="warning">
      <p><strong>Action Required:</strong> Code review turnaround time increased to 18 hours during mid-sprint. We need smaller PRs and faster peer reviews.</p>
    </div>

    <ul data-type="taskList">
      <li data-type="taskItem" data-checked="false">Limit PR size to under 300 lines of code &nbsp; <span data-type="collaborator-mention" data-name="Devon Vance" data-color="#f59e0b" data-role="Infrastructure SRE"></span></li>
      <li data-type="taskItem" data-checked="false">Automate end-to-end CRDT test suites in CI &nbsp; <span data-type="collaborator-mention" data-name="Sarah Miller" data-color="#10b981" data-role="Principal Engineer"></span></li>
    </ul>
  `,

  'sprint-42-retro': `
    <h1>Sprint 42 Retrospective: Team Synergy & Velocity</h1>
    <p>Sprint Status: <span data-type="status-badge" data-status="COMPLETED"></span> &nbsp; Facilitator: <span data-type="collaborator-mention" data-name="Sarah Miller" data-color="#10b981" data-role="Principal Engineer"></span></p>

    <div data-type="callout" data-callout-type="success">
      <p><strong>Sprint Highlights:</strong> Team delivered 48 story points (target: 45). Zero Sev-1 incidents reported in production, and split-screen peer testing mode reduced QA validation time by 60%!</p>
    </div>

    <div data-type="divider-with-label" data-label="WHAT WENT WELL"></div>
    <ul data-type="taskList">
      <li data-type="taskItem" data-checked="true">Seamless WebSocket reconnection logic handled transient network drops</li>
      <li data-type="taskItem" data-checked="true">Interactive status badge cycling made task prioritization instantaneous</li>
      <li data-type="taskItem" data-checked="true">Markdown and HTML export proved popular with external stakeholders</li>
    </ul>

    <div data-type="divider-with-label" data-label="AREAS FOR IMPROVEMENT"></div>
    <div data-type="callout" data-callout-type="warning">
      <p><strong>Action Required:</strong> Code review turnaround time increased to 18 hours during mid-sprint. We need smaller PRs and faster peer reviews.</p>
    </div>

    <ul data-type="taskList">
      <li data-type="taskItem" data-checked="false">Limit PR size to under 300 lines of code &nbsp; <span data-type="collaborator-mention" data-name="Devon Vance" data-color="#f59e0b" data-role="Infrastructure SRE"></span></li>
      <li data-type="taskItem" data-checked="false">Automate end-to-end CRDT test suites in CI &nbsp; <span data-type="collaborator-mention" data-name="Sarah Miller" data-color="#10b981" data-role="Principal Engineer"></span></li>
    </ul>
  `,

  'engineering-handbook': `
    <h1>Engineering Onboarding & Best Practices Handbook</h1>
    <p>Document Version: <span data-type="status-badge" data-status="COMPLETED"></span> &nbsp; Maintainer: <span data-type="collaborator-mention" data-name="Alex Chen" data-color="#3b82f6" data-role="Staff Architect"></span></p>

    <div data-type="callout" data-callout-type="info">
      <p><strong>Welcome to the Engineering Team!</strong> This handbook outlines our engineering principles, code review etiquette, Git trunk-based branch workflows, and deployment checklists.</p>
    </div>

    <div data-type="divider-with-label" data-label="CORE VALUES"></div>
    <h2>1. Engineering Guiding Principles</h2>
    <p>We value pragmatic architecture, reproducible builds, and psychological safety. When in doubt, write code that is easy to delete rather than easy to extend.</p>

    <h2>2. Day 1 Checklist for New Joiners</h2>
    <ul data-type="taskList">
      <li data-type="taskItem" data-checked="true">Set up GPG commit signing and hardware 2FA</li>
      <li data-type="taskItem" data-checked="true">Clone the repository and run <code>npm run dev</code></li>
      <li data-type="taskItem" data-checked="false">Schedule 1-on-1 intro coffee chat with your onboarding buddy</li>
      <li data-type="taskItem" data-checked="false">Ship your first tiny documentation or bugfix PR to production</li>
    </ul>
  `,

  'daily-standup-scratchpad': `
    <h1>Daily Standup, Priority Matrix & Quick Notes</h1>
    <p>Personal Status: <span data-type="status-badge" data-status="IN_PROGRESS"></span> &nbsp; Owner: <span data-type="collaborator-mention" data-name="Alex Chen" data-color="#3b82f6" data-role="Staff Architect"></span></p>

    <div data-type="callout" data-callout-type="tip">
      <p><strong>Focus Priority:</strong> Protect deep work blocks. Tackle the highest impact architectural task before noon.</p>
    </div>

    <div data-type="divider-with-label" data-label="TODAY'S PRIORITIES"></div>
    <h2>Top Deliverables</h2>
    <ul data-type="taskList">
      <li data-type="taskItem" data-checked="true">Review RFC-104 comments with Maya on security token lifecycle</li>
      <li data-type="taskItem" data-checked="false">Finalize knowledge base nested document tree component</li>
      <li data-type="taskItem" data-checked="false">Benchmark CRDT awareness ping overhead across 50 simulated peers</li>
    </ul>

    <div data-type="divider-with-label" data-label="MEETING NOTES & QUICK SCRATCHPAD"></div>
    <p>Ideas for Q1: Explore local-first SQLite/CRDT offline synchronization with zero server roundtrip for instantaneous note taking.</p>
  `,
};
