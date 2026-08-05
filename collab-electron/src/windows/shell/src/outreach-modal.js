export function initOutreachModal() {
	window.shellApi.onOutreachShow(() => showModal());
}

function showModal() {
	if (document.getElementById("outreach-backdrop")) return;

	const backdrop = document.createElement("div");
	backdrop.id = "outreach-backdrop";

	const card = document.createElement("div");
	card.id = "outreach-card";
	card.setAttribute("role", "dialog");
	card.setAttribute("aria-modal", "true");
	card.setAttribute("aria-labelledby", "outreach-headline");
	card.innerHTML = `
		<h2 id="outreach-headline">You're one of Collab's most active users</h2>
		<p>We'd love to hear how you use it. A short conversation with you
		directly shapes what we build next.</p>
		<button type="button" id="outreach-schedule">Grab a time with us</button>
		<a href="#" id="outreach-snooze">Remind me later</a>
	`;

	backdrop.appendChild(card);
	document.body.appendChild(backdrop);

	const close = () => {
		document.removeEventListener("keydown", onKeydown, true);
		backdrop.remove();
	};
	const snooze = () => {
		window.shellApi.outreachSnooze().catch(() => {});
		close();
	};
	const onKeydown = (e) => {
		if (e.key === "Escape") {
			e.stopPropagation();
			snooze();
			return;
		}
		if (e.key === "Backspace" || e.key === "Delete") {
			e.stopPropagation();
			e.preventDefault();
		}
	};

	card.querySelector("#outreach-schedule").addEventListener("click", () => {
		window.shellApi.outreachSchedule().catch(() => {});
		close();
	});
	card.querySelector("#outreach-snooze").addEventListener("click", (e) => {
		e.preventDefault();
		snooze();
	});
	backdrop.addEventListener("click", (e) => {
		if (e.target === backdrop) snooze();
	});
	document.addEventListener("keydown", onKeydown, true);

	card.querySelector("#outreach-schedule").focus();
}
