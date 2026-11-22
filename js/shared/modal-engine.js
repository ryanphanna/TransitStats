
/**
 * ModalManager - Centralized modal orchestration for TransitStats.
 * Handles opening, closing, and automatic backdrop management.
 */
export const ModalManager = {
    _backdrop: null,

    init() {
        this._backdrop = document.getElementById('modal-backdrop');
        if (!this._backdrop) {
            this._backdrop = document.createElement('div');
            this._backdrop.id = 'modal-backdrop';
            this._backdrop.className = 'modal-backdrop hidden';
            document.body.appendChild(this._backdrop);
        }

        if (this._listening) return;
        this._listening = true;
        this._setupListeners();
    },

    _setupListeners() {
        // Universal close on backdrop click
        this._backdrop.addEventListener('click', () => this.closeAll());

        // Universal close on ESC key
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') this.closeAll();
        });

        // Delegate data-close-modal attributes
        document.body.addEventListener('click', (e) => {
            if (e.target.closest('[data-close-modal]')) {
                this.closeAll();
            }
        });
    },

    /**
     * Open a specific modal by ID.
     * @param {string} modalId 
     */
    open(modalId) {
        const modal = document.getElementById(modalId);
        if (!modal) {
            console.error(`ModalManager: Modal with ID "${modalId}" not found.`);
            return;
        }

        this._backdrop.classList.remove('hidden');
        modal.classList.remove('hidden');
        
        // Trigger generic "open" animation class
        modal.classList.add('modal-active');

        // Optional: auto-focus primary input
        const firstInput = modal.querySelector('input:not([type="hidden"]), select, textarea');
        if (firstInput) setTimeout(() => firstInput.focus(), 100);
    },

    /**
     * Close all open modals.
     */
    closeAll() {
        this._backdrop.classList.add('hidden');
        document.querySelectorAll('.modal').forEach(m => {
            m.classList.add('hidden');
            m.classList.remove('modal-active');
        });
    }
};

window.ModalManager = ModalManager; // Legacy support
