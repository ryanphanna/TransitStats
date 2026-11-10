# TransitStats

A transit trip tracker for enthusiasts to analyze and visualize personal ridership.

## Problem

Transit riders have almost no personal tracking tools built for transit. There is still no simple way to build and explore a detailed record of routes, stops, and travel patterns over time.

## Features

- **SMS + MMS Logging**: Start and end trips by text, stop code, stop name, direction shorthand, or stop-sign photo, with route- and direction-aware stop matching.
- **History + AI Queries**: Build a personal trip history over time, visualize ridership patterns, and ask natural-language questions about your rides.
- **Predictions + Journey Intelligence**: Get route-aware destination guesses and automatic journey linking that use learned trip patterns without ignoring the physical transit network.
- **Transit-Specific Learning**: Each completed trip teaches the system stop sequences, travel times, route-stop service, and transfer connections, improving the app over time.
- **Public Profiles**: Share aggregate ridership stats and streaks through a public-facing profile page.

## Stack

- **Frontend**: Vanilla JS (ES modules), Vite, Leaflet
- **Backend**: Firebase Auth, Firestore, Hosting, and Cloud Functions
- **Messaging**: Twilio SMS/MMS
- **AI + Models**: Anthropic Claude, Google Gemini, V4 logistic regression models, and V5 XGBoost models running through ONNX Runtime
- **Transit Intelligence**: Custom Prediction, Network, Transfer, and Habit engines

---

- [Roadmap](./docs/roadmap/ROADMAP.md)
- [Changelog](./CHANGELOG.md)
- [Security](./docs/SECURITY.md)
- [Documents](./DOCUMENTS.md)

Created by [Ryan Hanna](https://github.com/ryanphanna) | [ryanisnota.pro](https://ryanisnota.pro)

Powered by [Atlas](https://github.com/Civic-Minds/Atlas)
