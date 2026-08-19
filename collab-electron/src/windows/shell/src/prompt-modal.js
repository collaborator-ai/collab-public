export function promptForText({
	title,
	label,
	placeholder,
	initialValue,
}) {
	return new Promise((resolve) => {
		const backdrop = document.createElement("div");
		backdrop.id = "prompt-backdrop";

		const card = document.createElement("div");
		card.id = "prompt-card";
		card.setAttribute("role", "dialog");
		card.setAttribute("aria-modal", "true");
		card.setAttribute("aria-labelledby", "prompt-title");

		const heading = document.createElement("h2");
		heading.id = "prompt-title";
		heading.textContent = title;

		const labelEl = document.createElement("label");
		labelEl.htmlFor = "prompt-input";
		labelEl.textContent = label;

		const input = document.createElement("input");
		input.id = "prompt-input";
		input.type = "text";
		input.placeholder = placeholder ?? "";
		input.value = initialValue ?? "";

		const actions = document.createElement("div");
		actions.id = "prompt-actions";

		const cancelButton = document.createElement("button");
		cancelButton.id = "prompt-cancel";
		cancelButton.type = "button";
		cancelButton.textContent = "Cancel";

		const okButton = document.createElement("button");
		okButton.id = "prompt-ok";
		okButton.type = "button";
		okButton.textContent = "OK";

		actions.append(cancelButton, okButton);
		card.append(heading, labelEl, input, actions);
		backdrop.appendChild(card);
		document.body.appendChild(backdrop);

		let settled = false;
		const finish = (value) => {
			if (settled) return;
			settled = true;
			document.removeEventListener("keydown", onKeydown, true);
			backdrop.remove();
			resolve(value);
		};
		const commit = () => finish(input.value.trim());
		const cancel = () => finish(null);
		const onKeydown = (e) => {
			if (e.key === "Escape" && e.target !== input) {
				e.preventDefault();
				e.stopPropagation();
				cancel();
				return;
			}
			if (
				e.target !== input &&
				(e.key === "Backspace" || e.key === "Delete")
			) {
				e.preventDefault();
				e.stopPropagation();
			}
		};

		input.addEventListener("keydown", (e) => {
			if (e.key === "Enter") {
				e.preventDefault();
				commit();
			}
			if (e.key === "Escape") {
				e.preventDefault();
				cancel();
			}
			e.stopPropagation();
		});
		cancelButton.addEventListener("click", cancel);
		okButton.addEventListener("click", commit);
		backdrop.addEventListener("click", (e) => {
			if (e.target === backdrop) cancel();
		});
		document.addEventListener("keydown", onKeydown, true);

		input.focus();
		input.select();
	});
}
