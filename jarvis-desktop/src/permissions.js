/**
 * What JARVIS is allowed to do on this machine, and who decided.
 *
 * Nothing here is granted by default. Every capability starts closed, and the
 * first time JARVIS reaches for one the user is asked, in a native dialog, with
 * the specific thing named — not "allow desktop access?" but "let JARVIS open
 * Spotify?". The answer is remembered so the question is asked once per thing,
 * and any of it can be revoked.
 *
 * Pure on purpose: the decision logic is testable without Electron, a window or
 * a person clicking buttons, which is the only way to be confident that "ask
 * first" actually holds on every path.
 */

/** Everything JARVIS can be granted. There is no wildcard, by design. */
export const CAPABILITIES = {
  'apps.open': {
    label: 'Open an installed application',
    detail: 'Start a program that is already installed, as if you clicked it in the Start menu.',
    perTarget: true,
  },
  'files.open': {
    label: 'Open a file or folder',
    detail: 'Hand a file to whichever program normally opens it.',
    perTarget: true,
  },
  'clipboard.read': {
    label: 'Read the clipboard',
    detail: 'See what you have copied.',
    perTarget: false,
  },
  'clipboard.write': {
    label: 'Write to the clipboard',
    detail: 'Put text on the clipboard for you to paste.',
    perTarget: false,
  },
  'notify': {
    label: 'Show a notification',
    detail: 'Post a Windows notification.',
    perTarget: false,
  },
};

export function createGrants() {
  return { capabilities: {}, targets: {} };
}

const key = (capability, target) => `${capability}::${String(target).toLowerCase()}`;

/**
 * Has this exact thing been approved already? A per-target capability needs a
 * grant for that target specifically: approving Spotify never approves Outlook.
 */
export function isGranted(grants, capability, target = null) {
  const spec = CAPABILITIES[capability];
  if (!spec) return false;
  if (grants.capabilities[capability] === 'denied') return false;
  if (!spec.perTarget) return grants.capabilities[capability] === 'allowed';
  if (target == null) return false;
  return grants.targets[key(capability, target)] === 'allowed';
}

/** Record an answer. `remember: false` means this once, so nothing is stored. */
export function grant(grants, capability, target, decision, remember = true) {
  if (!CAPABILITIES[capability]) return grants;
  if (!remember) return grants;
  const spec = CAPABILITIES[capability];
  if (!spec.perTarget) {
    return { ...grants, capabilities: { ...grants.capabilities, [capability]: decision } };
  }
  if (target == null) {
    // For a per-target capability a blanket answer only makes sense as a
    // refusal — "never open anything". A blanket allow would be the wildcard
    // this model exists to avoid, so it is ignored.
    if (decision !== 'denied') return grants;
    return { ...grants, capabilities: { ...grants.capabilities, [capability]: 'denied' } };
  }
  return { ...grants, targets: { ...grants.targets, [key(capability, target)]: decision } };
}

/** Take a permission back. Used by the permissions panel and "revoke all". */
export function revoke(grants, capability, target = null) {
  if (capability == null) return createGrants();
  const spec = CAPABILITIES[capability];
  if (!spec) return grants;
  if (!spec.perTarget || target == null) {
    const capabilities = { ...grants.capabilities };
    delete capabilities[capability];
    const targets = Object.fromEntries(
      Object.entries(grants.targets).filter(([k]) => !k.startsWith(`${capability}::`)),
    );
    return { capabilities, targets };
  }
  const targets = { ...grants.targets };
  delete targets[key(capability, target)];
  return { ...grants, targets };
}

/** Everything currently granted, for the panel that shows and revokes it. */
export function listGrants(grants) {
  const out = [];
  for (const [capability, decision] of Object.entries(grants.capabilities)) {
    out.push({ capability, target: null, decision, label: CAPABILITIES[capability]?.label });
  }
  for (const [composite, decision] of Object.entries(grants.targets)) {
    const [capability, target] = composite.split('::');
    out.push({ capability, target, decision, label: CAPABILITIES[capability]?.label });
  }
  return out;
}

/** What the dialog should say. Naming the exact thing is the whole point. */
export function describeRequest(capability, target) {
  const spec = CAPABILITIES[capability];
  if (!spec) return null;
  return {
    title: 'JARVIS is asking for permission',
    message: spec.perTarget && target ? `${spec.label}: ${target}` : spec.label,
    detail: spec.detail,
  };
}

/**
 * Read a permissions file without trusting it. Only known capabilities and
 * known decisions survive, and keys are rebuilt rather than taken as written —
 * an edited file cannot grant something that does not exist, and cannot smuggle
 * in a key that looks granted but never matches a real lookup.
 */
export function normalise(raw) {
  const grants = createGrants();
  if (!raw || typeof raw !== 'object') return grants;

  const caps = raw.capabilities && typeof raw.capabilities === 'object' ? raw.capabilities : {};
  for (const [k, v] of Object.entries(caps)) {
    const spec = CAPABILITIES[k];
    if (!spec) continue;
    if (v !== 'allowed' && v !== 'denied') continue;
    // A blanket allow on a per-target capability is meaningless; drop it.
    if (spec.perTarget && v === 'allowed') continue;
    grants.capabilities[k] = v;
  }

  const targets = raw.targets && typeof raw.targets === 'object' ? raw.targets : {};
  for (const [k, v] of Object.entries(targets)) {
    const [capability, ...rest] = String(k).split('::');
    const spec = CAPABILITIES[capability];
    if (!spec || !spec.perTarget || !rest.length) continue;
    if (v !== 'allowed' && v !== 'denied') continue;
    grants.targets[key(capability, rest.join('::'))] = v;
  }
  return grants;
}
