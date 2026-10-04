const durationBucketsSeconds = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

type RequestMetric = {
  count: number;
  durationSeconds: number;
  bucketCounts: number[];
};

function escapeLabel(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n");
}

export class OperationsMetrics {
  private readonly requests = new Map<string, RequestMetric>();
  private collaborationSessionTicketsIssued = 0;
  private websocketConnections = 0;
  private activeCollaborationSessions = 0;
  private activeCollaborationRooms = 0;

  setCollaborationState(input: {
    websocketConnections: number;
    activeSessions: number;
    activeRooms: number;
  }): void {
    this.websocketConnections = input.websocketConnections;
    this.activeCollaborationSessions = input.activeSessions;
    this.activeCollaborationRooms = input.activeRooms;
  }

  recordRequest(input: {
    method: string;
    route: string;
    statusCode: number;
    durationSeconds: number;
  }): void {
    const key = JSON.stringify([input.method, input.route, input.statusCode]);
    let metric = this.requests.get(key);
    if (!metric) {
      metric = {
        count: 0,
        durationSeconds: 0,
        bucketCounts: durationBucketsSeconds.map(() => 0),
      };
      this.requests.set(key, metric);
    }
    metric.count += 1;
    metric.durationSeconds += input.durationSeconds;
    durationBucketsSeconds.forEach((bucket, index) => {
      if (input.durationSeconds <= bucket) metric.bucketCounts[index] += 1;
    });
    if (input.route.endsWith("/:documentId/collaboration-session") && input.statusCode < 400) {
      this.collaborationSessionTicketsIssued += 1;
    }
  }

  renderPrometheus(): string {
    const output = [
      "# HELP zhishu_http_requests_total Completed HTTP requests.",
      "# TYPE zhishu_http_requests_total counter",
      "# HELP zhishu_http_request_duration_seconds HTTP request duration in seconds.",
      "# TYPE zhishu_http_request_duration_seconds histogram",
      "# HELP zhishu_collaboration_session_tickets_issued_total Successful collaboration session tickets issued.",
      "# TYPE zhishu_collaboration_session_tickets_issued_total counter",
      "# HELP zhishu_websocket_connections Active WebSocket TCP connections.",
      "# TYPE zhishu_websocket_connections gauge",
      "# HELP zhishu_collaboration_sessions Active authenticated collaboration sessions.",
      "# TYPE zhishu_collaboration_sessions gauge",
      "# HELP zhishu_collaboration_active_rooms Active collaboration rooms.",
      "# TYPE zhishu_collaboration_active_rooms gauge",
    ];
    for (const [key, metric] of this.requests) {
      const [method, route, statusCode] = JSON.parse(key) as [string, string, number];
      const labels = `method="${escapeLabel(method)}",route="${escapeLabel(route)}",status="${statusCode}"`;
      output.push(`zhishu_http_requests_total{${labels}} ${metric.count}`);
      durationBucketsSeconds.forEach((bucket, index) => {
        output.push(
          `zhishu_http_request_duration_seconds_bucket{${labels},le="${bucket}"} ${metric.bucketCounts[index]}`,
        );
      });
      output.push(
        `zhishu_http_request_duration_seconds_bucket{${labels},le="+Inf"} ${metric.count}`,
        `zhishu_http_request_duration_seconds_sum{${labels}} ${metric.durationSeconds}`,
        `zhishu_http_request_duration_seconds_count{${labels}} ${metric.count}`,
      );
    }
    output.push(
      `zhishu_collaboration_session_tickets_issued_total ${this.collaborationSessionTicketsIssued}`,
      `zhishu_websocket_connections ${this.websocketConnections}`,
      `zhishu_collaboration_sessions ${this.activeCollaborationSessions}`,
      `zhishu_collaboration_active_rooms ${this.activeCollaborationRooms}`,
    );
    return `${output.join("\n")}\n`;
  }
}
