function normalizeOptions(options = []) {
    const seen = new Set();
    return options
        .map(option => {
            if (typeof option === 'string') {
                return { value: option.trim(), label: option.trim() };
            }
            return {
                value: String(option?.value || '').trim(),
                label: String(option?.label || option?.value || '').trim(),
            };
        })
        .filter(option => option.value && option.label)
        .filter(option => {
            const key = `${option.value.toLowerCase()}::${option.label.toLowerCase()}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        })
        .sort((a, b) => a.label.localeCompare(b.label));
}

function matches(option, query) {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return true;
    return option.label.toLocaleLowerCase().includes(needle)
        || option.value.toLocaleLowerCase().includes(needle);
}

/**
 * Agency combobox used by settings and the edit-trip modal. Settings can
 * disable free-form values so profile preferences stay tied to real agencies.
 * The selected raw value is kept in input.dataset.agencyValue so a display name
 * such as "Toronto Transit Commission" still saves the stored name "TTC".
 */
export function createAgencyAutocomplete({ input, options = [], onCommit, onInvalid, allowCustom = true } = {}) {
    if (!input) return null;

    const wrapper = input.closest('.agency-autocomplete') || input.parentElement;
    wrapper?.classList.add('agency-autocomplete');
    input.removeAttribute('list');
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-expanded', 'false');

    const menu = document.createElement('div');
    menu.className = 'agency-autocomplete-menu hidden';
    menu.setAttribute('role', 'listbox');
    const menuId = `${input.id || 'agency'}-suggestions`;
    menu.id = menuId;
    input.setAttribute('aria-controls', menuId);
    wrapper?.appendChild(menu);

    let normalizedOptions = normalizeOptions(options);
    let activeIndex = -1;
    let lastCommitted = null;

    const clearInvalid = () => {
        input.setCustomValidity('');
        input.removeAttribute('aria-invalid');
        wrapper?.classList.remove('agency-autocomplete-invalid');
    };

    const rejectInvalid = () => {
        input.setCustomValidity('Choose an agency from the suggestions.');
        input.setAttribute('aria-invalid', 'true');
        wrapper?.classList.add('agency-autocomplete-invalid');
        close();
        onInvalid?.();
    };

    const close = () => {
        menu.classList.add('hidden');
        input.setAttribute('aria-expanded', 'false');
        activeIndex = -1;
    };

    const commit = (option = null) => {
        const typedValue = input.value.trim();
        if (!typedValue) {
            const previousValue = lastCommitted;
            input.value = '';
            delete input.dataset.agencyValue;
            lastCommitted = null;
            clearInvalid();
            close();
            if (previousValue) onCommit?.(null, null);
            return;
        }
        const selected = option || normalizedOptions.find(item =>
            item.label.toLocaleLowerCase() === typedValue.toLocaleLowerCase()
            || item.value.toLocaleLowerCase() === typedValue.toLocaleLowerCase()
        );
        if (!selected && !allowCustom) {
            rejectInvalid();
            return;
        }
        const value = selected?.value || typedValue;
        const label = selected?.label || typedValue;
        clearInvalid();
        input.value = label;
        input.dataset.agencyValue = value;
        close();
        if (value !== lastCommitted) {
            lastCommitted = value;
            onCommit?.(value, selected || { value, label });
        }
    };

    const select = option => {
        input.value = option.label;
        commit(option);
    };

    const render = () => {
        const filtered = normalizedOptions.filter(option => matches(option, input.value)).slice(0, 8);
        menu.replaceChildren(...filtered.map((option, index) => {
            const item = document.createElement('button');
            item.type = 'button';
            item.className = 'agency-autocomplete-option';
            item.setAttribute('role', 'option');
            item.dataset.index = String(index);
            const label = document.createElement('strong');
            label.textContent = option.label;
            item.appendChild(label);
            if (option.value !== option.label) {
                const rawValue = document.createElement('span');
                rawValue.textContent = option.value;
                item.appendChild(rawValue);
            }
            item.addEventListener('mousedown', event => {
                event.preventDefault();
                select(option);
            });
            return item;
        }));

        if (filtered.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'agency-autocomplete-empty';
            empty.textContent = input.value.trim()
                ? (allowCustom ? 'Press Enter to use this agency' : 'Choose an agency from the list')
                : 'No agencies found';
            menu.appendChild(empty);
        }

        menu.classList.remove('hidden');
        input.setAttribute('aria-expanded', 'true');
        activeIndex = -1;
    };

    input.addEventListener('focus', render);
    input.addEventListener('input', () => {
        clearInvalid();
        delete input.dataset.agencyValue;
        render();
    });
    input.addEventListener('blur', () => {
        window.setTimeout(() => commit(), 0);
    });
    input.addEventListener('keydown', event => {
        const optionsInMenu = [...menu.querySelectorAll('.agency-autocomplete-option')];
        if (event.key === 'ArrowDown') {
            event.preventDefault();
            if (menu.classList.contains('hidden')) render();
            activeIndex = Math.min(activeIndex + 1, optionsInMenu.length - 1);
        } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            activeIndex = Math.max(activeIndex - 1, 0);
        } else if (event.key === 'Enter') {
            event.preventDefault();
            if (activeIndex >= 0 && optionsInMenu[activeIndex]) {
                select(normalizedOptions.filter(option => matches(option, input.value)).slice(0, 8)[activeIndex]);
            } else {
                commit();
            }
        } else if (event.key === 'Escape') {
            close();
        }
        optionsInMenu.forEach((item, index) => item.classList.toggle('active', index === activeIndex));
    });

    document.addEventListener('click', event => {
        if (!wrapper?.contains(event.target)) close();
    });

    return {
        setOptions(nextOptions = []) {
            normalizedOptions = normalizeOptions(nextOptions);
            if (!menu.classList.contains('hidden')) render();
        },
        setValue(value) {
            const selected = normalizedOptions.find(option => option.value === value || option.label === value);
            if (!selected && !allowCustom) {
                input.value = '';
                delete input.dataset.agencyValue;
                lastCommitted = null;
                clearInvalid();
                return;
            }
            input.value = selected?.label || value || '';
            input.dataset.agencyValue = selected?.value || value || '';
            lastCommitted = selected?.value || value || null;
        },
        clear({ commit = true } = {}) {
            const previousValue = lastCommitted;
            input.value = '';
            delete input.dataset.agencyValue;
            lastCommitted = null;
            clearInvalid();
            close();
            if (commit && previousValue) onCommit?.(null, null);
        },
        getValue() {
            return input.dataset.agencyValue || (allowCustom ? input.value.trim() : '');
        },
    };
}
