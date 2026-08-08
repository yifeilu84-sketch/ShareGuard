"use strict";

(function exposeShareGuardApi(global) {
  class ShareGuardApiError extends Error {
    constructor(message, options = {}) {
      super(message);
      this.name = "ShareGuardApiError";
      this.status = Number(options.status || 0);
      this.code = String(options.code || "request_failed");
      this.retryAfter = Number(options.retryAfter || 0);
    }
  }

  class ShareGuardApiClient {
    constructor(baseUrl = "") {
      this.baseUrl = normalizeBaseUrl(baseUrl);
      this.username = "";
      this.password = "";
      this.reviewToken = "";
    }

    setCredentials(username, password) {
      this.username = String(username || "").trim();
      this.password = String(password || "");
    }

    clearCredentials() {
      this.username = "";
      this.password = "";
    }

    setReviewToken(token) {
      this.reviewToken = String(token || "").trim();
    }

    clearReviewToken() {
      this.reviewToken = "";
    }

    async request(path, options = {}) {
      const headers = new Headers(options.headers || {});
      headers.set("Accept", options.accept || "application/json");
      if (options.reviewAccess && this.reviewToken) {
        headers.set("Authorization", `Bearer ${this.reviewToken}`);
      } else if (this.username && this.password) {
        headers.set("Authorization", basicAuthorization(this.username, this.password));
      }
      const response = await fetch(this.url(path), {
        method: options.method || "GET",
        headers,
        body: options.body,
        cache: "no-store",
        credentials: "omit",
        mode: this.baseUrl ? "cors" : "same-origin",
        referrerPolicy: "no-referrer"
      });
      if (response.ok && options.responseType === "blob") {
        return {
          blob: await response.blob(),
          sha256: String(response.headers.get("X-ShareGuard-Media-SHA256") || "").toLowerCase(),
          contentDisposition: String(response.headers.get("Content-Disposition") || "")
        };
      }
      const text = await response.text();
      let payload = null;
      if (text) {
        try {
          payload = JSON.parse(text);
        } catch {
          payload = null;
        }
      }
      if (!response.ok) {
        const detail = payload?.error && typeof payload.error === "object" ? payload.error : {};
        throw new ShareGuardApiError(
          detail.message || `ShareGuard API returned HTTP ${response.status}`,
          {
            status: response.status,
            code: detail.code || "request_failed",
            retryAfter: response.headers.get("Retry-After")
          }
        );
      }
      if (options.requireJson !== false && !payload) {
        throw new ShareGuardApiError("ShareGuard API returned invalid JSON.", {
          status: response.status,
          code: "invalid_response"
        });
      }
      return payload;
    }

    url(path) {
      if (!String(path).startsWith("/")) throw new TypeError("API path must be absolute.");
      return this.baseUrl ? new URL(path, `${this.baseUrl}/`).toString() : path;
    }

    ready() {
      return this.request("/v1/ready");
    }

    health() {
      return this.request("/v1/health");
    }

    analyze(file, options = {}) {
      if (!(file instanceof Blob)) throw new TypeError("A media file is required.");
      const body = new FormData();
      const fileName = String(file.name || options.fileName || "upload");
      body.append("image", file, fileName);
      const headers = {
        "Accept-Language": String(options.locale || "zh-CN"),
        "X-File-Name": fileName,
        "X-ShareGuard-Version-Role": String(options.versionRole || "original")
      };
      if (options.caseId) headers["X-ShareGuard-Case-Id"] = String(options.caseId);
      if (options.title) {
        headers["X-ShareGuard-Case-Title-B64"] = utf8Base64Url(options.title);
      }
      return this.request("/v1/analyze", { method: "POST", headers, body });
    }

    listCases(filters = {}) {
      const query = new URLSearchParams();
      if (filters.status) query.set("status", String(filters.status));
      if (filters.priority) query.set("priority", String(filters.priority));
      if (filters.cursor !== undefined && filters.cursor !== null) query.set("cursor", String(filters.cursor));
      if (filters.limit) query.set("limit", String(filters.limit));
      const suffix = query.toString() ? `?${query}` : "";
      return this.request(`/v1/cases${suffix}`);
    }

    getCase(caseId) {
      return this.request(`/v1/cases/${casePath(caseId)}`);
    }

    deleteCase(caseId) {
      return this.request(`/v1/cases/${casePath(caseId)}`, { method: "DELETE" });
    }

    recordDecision(caseId, decision) {
      return this.postCaseCommand(caseId, "decision", decision);
    }

    replaceAnnotations(caseId, versionId, annotations) {
      return this.postCaseCommand(caseId, "annotations", {
        version_id: String(versionId),
        annotations
      });
    }

    declareProvenance(caseId, provenance) {
      return this.postCaseCommand(caseId, "provenance", provenance);
    }

    recordFeedback(caseId, feedback) {
      return this.postCaseCommand(caseId, "feedback", feedback);
    }

    updateWorkflow(caseId, workflow) {
      return this.postCaseCommand(caseId, "workflow", workflow);
    }

    addComment(caseId, comment) {
      return this.postCaseCommand(caseId, "comments", comment);
    }

    issueReviewGrant(caseId, grant) {
      return this.postCaseCommand(caseId, "review-grants", grant);
    }

    revokeReviewGrant(caseId, grantId) {
      const grant = String(grantId || "");
      if (!/^sg_grant_[0-9a-f]{32}$/.test(grant)) throw new TypeError("Invalid review grant id.");
      return this.postCaseCommand(caseId, `review-grants/${encodeURIComponent(grant)}/revoke`, {});
    }

    getCaseMedia(caseId, versionId) {
      return this.request(
        `/v1/cases/${casePath(caseId)}/versions/${versionPath(versionId)}/media`,
        { responseType: "blob", requireJson: false }
      );
    }

    getReviewCase() {
      return this.request("/v1/review/case", { reviewAccess: true });
    }

    addReviewComment(comment) {
      return this.request("/v1/review/comments", {
        method: "POST",
        reviewAccess: true,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(comment || {})
      });
    }

    replaceReviewAnnotations(versionId, annotations) {
      return this.request("/v1/review/annotations", {
        method: "POST",
        reviewAccess: true,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version_id: versionPath(versionId), annotations })
      });
    }

    getReviewMedia(versionId) {
      return this.request(`/v1/review/media/${versionPath(versionId)}`, {
        reviewAccess: true,
        responseType: "blob",
        requireJson: false
      });
    }

    sealCase(caseId) {
      return this.postCaseCommand(caseId, "seal", {});
    }

    getMetrics() {
      return this.request("/v1/metrics");
    }

    getTrustRoot() {
      return this.request("/v1/trust-root");
    }

    postCaseCommand(caseId, command, payload) {
      return this.request(`/v1/cases/${casePath(caseId)}/${command}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload || {})
      });
    }
  }

  function casePath(caseId) {
    const value = String(caseId || "").trim();
    if (!/^sg_case_[0-9a-f]{32}$/.test(value)) throw new TypeError("Invalid case id.");
    return encodeURIComponent(value);
  }

  function versionPath(versionId) {
    const value = String(versionId || "").trim();
    if (!/^sg_ver_[0-9a-f]{32}$/.test(value)) throw new TypeError("Invalid version id.");
    return encodeURIComponent(value);
  }

  function normalizeBaseUrl(value) {
    if (!value) return "";
    const parsed = new URL(String(value));
    if (
      parsed.protocol !== "https:"
      || parsed.username
      || parsed.password
      || parsed.pathname !== "/"
      || parsed.search
      || parsed.hash
    ) {
      throw new TypeError("Invalid ShareGuard API base URL.");
    }
    return parsed.origin;
  }

  function basicAuthorization(username, password) {
    const bytes = new TextEncoder().encode(`${username}:${password}`);
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    }
    return `Basic ${global.btoa(binary)}`;
  }

  function utf8Base64Url(value) {
    const bytes = new TextEncoder().encode(String(value));
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    }
    return global.btoa(binary)
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/g, "");
  }

  global.ShareGuardApi = Object.freeze({
    Client: ShareGuardApiClient,
    Error: ShareGuardApiError,
    createClient(options = {}) {
      return new ShareGuardApiClient(options.baseUrl || "");
    }
  });
})(window);
