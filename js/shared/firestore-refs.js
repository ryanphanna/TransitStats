// The db wrapper's batch takes wrapper documents (which carry `_ref`), but
// callers also hold query snapshot docs (which carry `ref`) or raw references.
// Accept all three so a snapshot doc can't reach the SDK as `undefined`.
export function resolveDocRef(document) {
    const ref = document?._ref || document?.ref || document;
    if (!ref || typeof ref !== 'object') {
        throw new Error('Expected a Firestore document or reference.');
    }
    return ref;
}
