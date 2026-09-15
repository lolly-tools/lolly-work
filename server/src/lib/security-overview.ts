// SPDX-License-Identifier: MPL-2.0
/** Public, illustrative architecture. No instance data or live service status. */
const nodes = [
  {
    id: 'work',
    label: 'Your organisation',
    subtitle: 'Identity, rules and shared services',
    title: 'Work adds your organisation’s controls.',
    body: 'Lolly Work connects people to the tools, rules and services your organisation provides.',
    security:
      'Sign-in, roles and permissions control access. The server checks permissions before it serves governed work.',
    platform:
      'Your team runs identity, storage, updates, monitoring and backups. Usage reporting depends on the settings you choose.',
    limit:
      'Shared sessions and server renders can send content to Work. The selected features decide what the server receives.',
    doc: 'overview',
  },
  {
    id: 'network',
    label: 'The connection',
    subtitle: 'What crosses the network',
    title: 'Each connection moves something specific.',
    body: 'A device may request tools and rules, send permitted usage labels, or send content to a shared service.',
    security:
      'Review the destinations and data for each feature. Tool network allowlists, browser policy and network controls each have a part.',
    platform:
      'Prepare the tools, assets and models needed for offline work. Check what a disconnected device can still use.',
    limit:
      'Local processing does not mean that every feature is offline. New sign-ins and shared services need a connection.',
    doc: 'deployment',
  },
  {
    id: 'host',
    label: 'The app and its bridge',
    subtitle: 'Access to device capabilities',
    title: 'The app controls how a tool runs.',
    body: 'The host bridge connects a tool to supported features such as rendering, file access and network requests.',
    security:
      'The current web app puts untrusted tool scripts in strict Workers: separate execution contexts with a limited bridge. It refuses them if that isolation cannot start.',
    platform:
      'Review the exact app and release you deploy. Web, desktop and command-line apps implement the same bridge contract in different environments.',
    limit:
      'Verified built-in scripts can still run in the page. The bridge alone is not a sandbox, so catalog review and signing keys matter.',
    doc: 'security-platform',
  },
  {
    id: 'engine',
    label: 'Tools and engine',
    subtitle: 'Make the output on the device',
    title: 'Local work happens on the device.',
    body: 'Lolly takes the tool, inputs and assets, then uses the app’s capabilities to make the output.',
    security:
      'A local render can avoid uploading working content. Catalog signatures check tool-file integrity; Content Credentials record the output’s provenance.',
    platform:
      'The same engine is used by local apps and by Work’s optional server renderer. Choose where each workflow should run.',
    limit:
      'A signed tool still needs review. The engine is not a universal WASM sandbox, and a signature does not prove that content is true.',
    doc: 'sharing',
  },
  {
    id: 'data',
    label: 'Files and keys',
    subtitle: 'Inputs, exports and local storage',
    title: 'Follow every copy of the work.',
    body: 'Local files and signing keys live on the device. Sync, sharing and server rendering can create copies elsewhere.',
    security:
      'Enrolled device signing keys are non-extractable. Apply endpoint encryption and access policy to protect local content.',
    platform:
      'Include shared history, database records, stored files, downloads and backups in retention and recovery plans.',
    limit:
      'Browser storage is not a promise of disk encryption. Deleting a server record cannot recall every downloaded copy.',
    doc: 'data-lifecycle',
  },
];
const scenarios = [
  {
    id: 'local',
    label: 'Work locally',
    title: 'Make a file on your device.',
    body: 'Use a tool and assets already available in the app. This workflow does not need Lolly Work.',
    down: 'Tools already on the device',
    up: '',
    result: 'The inputs and export stay on the device in this example.',
    offline:
      'Local work can continue when the app, tool and all required assets or models are already available.',
    steps: [
      { node: 'data', text: 'Open a file or enter inputs on the device.' },
      {
        node: 'host',
        text: 'The app loads the tool and applies its execution rules.',
      },
      {
        node: 'engine',
        text: 'The engine makes the output using local capabilities.',
      },
      {
        node: 'data',
        text: 'Save the result on the device. No upload was needed for this workflow.',
      },
    ],
  },
  {
    id: 'managed',
    label: 'Apply organisation rules',
    title: 'Keep the rendering local. Add your organisation’s rules.',
    body: 'Sign in to Work and load the approved catalog and policy. Usage reporting depends on your settings.',
    down: 'Approved tools and rules ↓',
    up: 'Sign-in and permitted usage labels ↑',
    result:
      'Identity and policy requests cross the network. This example still renders locally; syncing content is a separate choice.',
    offline:
      'Existing local work may remain available. New sign-ins, policy updates and immediate server revocation need a connection.',
    steps: [
      {
        node: 'work',
        text: 'Sign in. Work checks the account’s current roles and permissions.',
      },
      {
        node: 'network',
        text: 'The app requests approved tools and rules. Permitted usage labels may travel back.',
      },
      {
        node: 'host',
        text: 'The app applies the received tool settings and its own execution rules.',
      },
      {
        node: 'engine',
        text: 'Make and save the output locally. Content sync is outside this example.',
      },
    ],
  },
  {
    id: 'shared',
    label: 'Use shared services',
    title: 'Choose a service that needs shared content.',
    body: 'Sync, collaboration and server rendering send selected work to services your organisation operates.',
    down: 'Results and shared changes ↓',
    up: 'Selected inputs and shared work ↑',
    result:
      'Work can receive content in this example. Shared records, outputs and stored files need retention and access rules.',
    offline:
      'Server rendering, collaboration and sync cannot complete without a connection. Available local work is a separate path.',
    steps: [
      {
        node: 'data',
        text: 'Choose inputs for a server render, or a session to share.',
      },
      { node: 'network', text: 'The selected content is sent to Work.' },
      {
        node: 'work',
        text: 'Work checks permissions and processes the request in the configured service.',
      },
      {
        node: 'data',
        text: 'Receive the result. The server or other recipients may retain additional copies.',
      },
    ],
  },
];
const esc = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ]!,
  );
export function securityOverviewHtml(): string {
  const active = nodes[3]!;
  const nodeButton = (id: string) => {
    const n = nodes.find((n) => n.id === id)!;
    return `<button type="button" class="arch-node" data-node="${id}" aria-pressed="${id === active.id}" aria-controls="arch-detail"><strong>${esc(n.label)}</strong><span>${esc(n.subtitle)}</span></button>`;
  };
  return `<section id="security-platform" class="architecture" aria-labelledby="arch-title">
    <div class="section-head"><div><p class="eyebrow">Security and platform</p><h2 id="arch-title">See where the work happens.</h2></div><a href="/admin#/docs?doc=security-platform">Read the full guide →</a></div>
    <p>Lolly works on the device. Lolly Work adds organisation rules and shared services. Choose a workflow to see what moves between them.</p>
    <div class="arch-controls"><fieldset class="arch-modes"><legend class="sr-only">Choose a workflow</legend>${scenarios.map((s, i) => `<button type="button" data-scenario="${s.id}" aria-pressed="${i === 0}">${esc(s.label)}</button>`).join('')}</fieldset><label class="arch-offline"><input type="checkbox" id="arch-offline"> Explain offline use</label></div>
    <div class="arch-scenario" aria-live="polite"><h3 id="arch-scenario-title">${scenarios[0]!.title}</h3><p id="arch-scenario-body">${scenarios[0]!.body}</p></div>
    <div class="arch-layout"><div class="arch-map" aria-label="Lolly and Lolly Work components"><div class="arch-zone" id="arch-work-zone"><p class="zone-label">Your organisation <span>Lolly Work</span></p>${nodeButton('work')}<p class="zone-note" id="arch-work-note">Not needed for this workflow</p></div>
      <div class="arch-connection">${nodeButton('network')}<p id="arch-flow-down">${scenarios[0]!.down}</p><p id="arch-flow-up" hidden></p></div>
      <div class="arch-zone"><p class="zone-label">Your device <span>Lolly</span></p>${nodeButton('host')}<span class="arch-arrow" aria-hidden="true">↓</span><div class="arch-device-bottom">${nodeButton('engine')}${nodeButton('data')}</div></div><p class="arch-help">Choose a component to learn what it does.</p>
    </div><div id="arch-detail" class="arch-detail" aria-live="polite"><p class="eyebrow" id="arch-detail-label">${active.label}</p><h3 id="arch-detail-title">${active.title}</h3><p id="arch-detail-body">${active.body}</p><fieldset class="arch-lenses"><legend class="sr-only">Choose a perspective</legend><button type="button" data-lens="security" aria-pressed="true">Security</button><button type="button" data-lens="platform" aria-pressed="false">Platform operations</button></fieldset><p id="arch-detail-view">${active.security}</p><div class="arch-limit"><strong>What to keep in mind</strong><p id="arch-detail-limit">${active.limit}</p></div><a id="arch-detail-link" href="/admin#/docs?doc=${active.doc}">More detail →</a></div></div>
    <p class="arch-result" id="arch-result" aria-live="polite">${scenarios[0]!.result}</p>
    <div class="arch-trace"><div><strong id="arch-step-label">Follow the work, step by step</strong><p id="arch-step-text" aria-live="polite">Start with the inputs and follow them to the result.</p></div><button type="button" id="arch-next" class="btn secondary">Follow this workflow →</button></div>
    <p class="arch-caption">An explanation of the architecture, not a live check of this deployment.</p>
    <noscript><p>Local work can use prepared tools offline. Organisation rules need a connection to refresh. Shared services can receive content. <a href="/admin#/docs?doc=security-platform">Read the guide for all three workflows.</a></p></noscript>
    <script type="application/json" id="arch-data">${JSON.stringify({ nodes, scenarios }).replace(/</g, '\\u003c')}</script>
  </section>`;
}
