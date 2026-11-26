// `orca plugin check` renders the panel once per scenario, each with the worker on a fresh host.
// The first-run state (nothing configured yet) is the one to look at; the table itself is covered by
// src/panel.test.tsx with a stubbed worker answer.
import { defineCheck } from 'orca/testing'

export default defineCheck({
  notConfigured: {}
})