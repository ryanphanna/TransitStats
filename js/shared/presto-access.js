// PRESTO import is limited to admins and the PRESTO pilot.
export const PRESTO_DENIED_MESSAGE = "This account isn't set up for importing yet.";

export function canUsePrestoImport({ isAdmin = false, pilot = null } = {}) {
    return isAdmin === true || pilot === 'presto';
}
