# Security Model

TransitStats is built with privacy and security as its foundation.

- **Authentication & Authorization**: A multi-tier model using invite-only whitelists and role-based access control (RBAC).
- **Data Ownership**: Firestore rules ensure users only access their own trips, profiles, and templates. Trip documents are tied to your account (`userId`) and are never publicly readable, even when a trip is marked public on your profile — only aggregate stats (trip/hour totals, an anonymized location heatmap) are exposed there, computed server-side. The separate leaderboard is opt-in and exposes only the chosen public identity and completed logged-trip count through a server-maintained projection.
- **Stop-Sign Photos**: MMS photos sent to log a trip are fetched into memory, sent directly to Gemini for parsing, and discarded — they are never written to Cloud Storage, Firestore, or disk. Image EXIF metadata (which can carry a phone's GPS location) is never read or extracted; the only location data TransitStats stores is your phone's own GPS reading at trip start/end.
- **AI Privacy**: TransitStats uses Gemini to interpret and process location-based trip data.
    - **Privacy Commitment**: Covered by [Google's Enterprise Privacy protections](https://cloud.google.com/vertex-ai/docs/generative-ai/learn/privacy).
    - **No Training**: Your trip data is never used to train global AI models.
    - **Isolation**: Data is processed in isolated sessions and is not shared with other users.
- **Secure Integration**: Server-side validation, rate limiting, and secure secret management via Google Cloud.
- **Third-Party Data**: Route and stop metadata is enriched from [Atlas](https://github.com/Civic-Minds/Atlas), a public, read-only transit data source. No credentials or user data are shared with it.
- **Shared Network Intelligence**: Trips help make predictions smarter for everyone (e.g. confirming a stop serves a given route), but the shared/pooled collections this writes to (`stopRoutes`, `transferIndex`, the global route-level `networkGraph`) never carry a `userId` — only the aggregate fact. Your personal prediction data (a per-user `networkGraph` doc) does reference your account, but it isn't exposed to other users or readable by clients at all — only Cloud Functions running with the Admin SDK can access it.
- **Automated Scanning**: Continuous monitoring via Dependabot and CodeQL for potential vulnerabilities.

### Server-Side Security (Cloud Functions)

- **SMS Validation**: Incoming webhooks from Twilio are validated to prevent spoofing.
- **Rate Limiting**: Applied to all SMS processing to prevent abuse.
- **Secret Management**: API keys (Gemini, Twilio) are stored in Google Cloud Secret Manager via `defineSecret`.
- **Frontend Configuration**: The browser uses Firebase's public client configuration for authentication and Firestore access, with authorization enforced by Firebase rules and server-side checks. Maps use keyless Leaflet tiles from CARTO/OpenStreetMap; no Google Maps key is used.

### Repository Security (GitHub)

- **Dependency Scanning**: Dependabot is enabled for automated detection and patching of vulnerable npm packages.
- **Static Testing**: CodeQL is configured to automatically scan the JavaScript codebase for common vulnerabilities on every push and pull request.

---

## Security Incidents

For history of security audits and incident remediation reports, please see **[INCIDENTS.md](./INCIDENTS.md)**.

## Reporting a Vulnerability

If you discover a security vulnerability in this project, please report it via the **[GitHub Private Vulnerability Reporting](https://github.com/ryanphanna/TransitStats/security/advisories/new)** tool. Private reports allow for a secure disclosure process before a formal patch is released.

### What to Include

- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

### Response Timeline

- **Initial response**: Within 48 hours
- **Status update**: Within 7 days
- **Resolution**: Depends on severity and complexity
