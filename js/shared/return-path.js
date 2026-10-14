// Where to send a visitor after sign-in. Only same-site paths are accepted,
// so a crafted ?next= link can't bounce someone to another site.
export function safeReturnPath(search, fallback = '/dashboard') {
    const next = new URLSearchParams(search).get('next');
    return next && /^\/[A-Za-z0-9_\-/]*$/.test(next) && !next.startsWith('//') ? next : fallback;
}

export function loginUrlFor(pathname) {
    return `/?next=${encodeURIComponent(pathname)}`;
}
