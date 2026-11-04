// Apply theme immediately to prevent white flash
// This runs before any other scripts or CSS. Dark unless the user picked
// "light" or "system" in Settings (src/components/SettingsPanel.ts).
(function() {
	const theme = localStorage.getItem('theme') || 'dark';
	const systemDark = window.matchMedia('(prefers-color-scheme: dark)');
	const apply = () => {
		const current = localStorage.getItem('theme') || 'dark';
		document.documentElement.classList.toggle('dark', current === 'dark' || (current === 'system' && systemDark.matches));
	};
	if (theme === 'dark' || (theme === 'system' && systemDark.matches)) {
		document.documentElement.classList.add('dark');
	}
	systemDark.addEventListener('change', apply);
})();
