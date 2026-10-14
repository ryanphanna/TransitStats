import { createIcons, ArrowRight, ArrowUpRight, Check, KeyRound, LockKeyhole, Mail, Smartphone, Upload, X, Zap } from 'lucide';

// Only the icons the app actually uses are bundled (no CDN script, nothing render-blocking).
// Add a name here when a new data-lucide icon is introduced.
const icons = { ArrowRight, ArrowUpRight, Check, KeyRound, LockKeyhole, Mail, Smartphone, Upload, X, Zap };

export function refreshIcons() {
    createIcons({ icons });
}
