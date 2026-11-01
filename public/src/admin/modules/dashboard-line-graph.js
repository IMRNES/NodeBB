import {
	Chart,
	LineController,
	CategoryScale,
	LinearScale,
	LineElement,
	PointElement,
	Tooltip,
	Filler,
} from 'chart.js';

import * as Benchpress from 'benchpressjs';
import * as modals from 'modals';
import * as translator from '../../modules/translator';
import * as api from '../../modules/api';
import * as hooks from '../../modules/hooks';

const MOBILE_USER_AGENT_REGEXP = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i;
// Deliberately unanchored so that existing, lenient input keeps being accepted
const DATE_REGEXP = /\d{4}-\d{2}-\d{2}/;
const HOURS_PER_DAY = 24;
const MS_PER_DAY = 1000 * 60 * 60 * 24;
const DEFAULT_UNITS = 'hours';

Chart.register(
	LineController,
	CategoryScale,
	LinearScale,
	LineElement,
	PointElement,
	Tooltip,
	Filler
);

/** @type {Chart|null} Chart currently rendered on the page */
let currentChart = null;

/**
 * Renders the analytics line graph of an admin dashboard page and keeps it in
 * sync with the range selector.
 *
 * @param {object} params
 * @param {string} params.set Analytics data set to request, e.g. `topics`
 * @param {number[]} [params.dataset] Pre-loaded data points, fetched from the API when omitted
 * @returns {Promise<Chart>} The rendered chart instance
 */
export async function init({ set, dataset }) {
	const canvas = document.getElementById('analytics-traffic');
	const canvasCtx = canvas.getContext('2d');
	const trafficLabels = utils.getHoursArray();

	if (MOBILE_USER_AGENT_REGEXP.test(navigator.userAgent)) {
		Chart.defaults.plugins.tooltip.enabled = false;
	}

	handleUpdateControls({ set });

	const t = translator.Translator.create();
	const key = await t.translateKey(`admin/menu:${ajaxify.data.template.name.replace('admin/', '')}`, []);

	const data = {
		labels: trafficLabels,
		datasets: [
			{
				label: key,
				yAxisID: 'left-y-axis',
				fill: true,
				tension: 0.25,
				backgroundColor: 'rgba(151,187,205,0.2)',
				borderColor: 'rgba(151,187,205,1)',
				pointBackgroundColor: 'rgba(151,187,205,1)',
				pointHoverBackgroundColor: 'rgba(151,187,205,1)',
				pointBorderColor: '#fff',
				pointHoverBorderColor: 'rgba(151,187,205,1)',
				data: dataset || new Array(HOURS_PER_DAY).fill(0),
			},
		],
	};

	canvas.width = $(canvas).parent().width();

	currentChart = new Chart(canvasCtx, {
		type: 'line',
		data: data,
		options: {
			responsive: true,
			maintainAspectRatio: false,
			scales: {
				'left-y-axis': {
					type: 'linear',
					position: 'left',
					beginAtZero: true,
					title: {
						display: false,
						text: key,
					},
				},
			},
			plugins: {
				legend: {
					display: false,
					position: 'bottom',
				},
			},
			interaction: {
				intersect: false,
				mode: 'index',
			},
		},
	});

	if (!dataset) {
		await update(set);
	}

	return currentChart;
}

/**
 * Binds the range selector so that picking a range refreshes the graph.
 *
 * @param {object} params
 * @param {string} params.set Analytics data set the graph displays
 */
function handleUpdateControls({ set }) {
	$('[data-action="updateGraph"]').on('change', function () {
		const $select = $(this);
		let amount = $select.val();

		if (amount === 'custom') {
			showCustomRangeSelector($select);
			return;
		}

		const units = amount === '1' ? 'hours' : 'days';
		if (amount === '1') { // change 1 day to 24 hours
			amount = String(HOURS_PER_DAY);
		}

		const until = new Date();
		if (units === 'days') {
			until.setHours(0, 0, 0, 0);
		}

		update(set, units, until.getTime(), amount);
		$('[data-action="updateGraph"] option[value="range"]').addClass('hidden');
	});

	/**
	 * Opens the custom date range dialog and refreshes the graph once it is submitted.
	 *
	 * @param {jQuery} $select Range selector the dialog was opened from
	 */
	function showCustomRangeSelector($select) {
		Benchpress.render('admin/partials/pageviews-range-select', {}).then(async (html) => {
			const modal = await modals.dialog({
				title: '[[admin/dashboard:page-views-custom]]',
				message: html,
				buttons: {
					submit: {
						label: '[[global:search]]',
						className: 'btn-primary',
						callback: submit,
					},
				},
			});

			modal.on('shown.bs.modal', function () {
				const date = new Date();
				const today = date.toISOString().slice(0, 10);
				date.setDate(date.getDate() - 1);
				const yesterday = date.toISOString().slice(0, 10);

				modal.find('#startRange').val($select.attr('data-startRange') || yesterday);
				modal.find('#endRange').val($select.attr('data-endRange') || today);
			});

			function submit() {
				const { startRange, endRange } = modal.find('form').serializeObject();

				if (!startRange && !endRange) {
					// No range? Assume last 30 days
					update(set, 'days');
					return;
				}
				if (!DATE_REGEXP.test(startRange) || !DATE_REGEXP.test(endRange)) {
					// Invalid input, show the error and keep the dialog open
					modal.find('.alert-danger').removeClass('hidden');
					return false;
				}

				const until = new Date(endRange);
				until.setDate(until.getDate() + 1);
				const untilTimestamp = until.getTime();
				const amount = (untilTimestamp - new Date(startRange).getTime()) / MS_PER_DAY;

				update(set, 'days', untilTimestamp, amount);

				// Update "custom range" label
				$select.attr('data-startRange', startRange);
				$select.attr('data-endRange', endRange);
				$select.find('option[value="range"]').text(`${startRange} - ${endRange}`);
				$select.val('range');
			}
		});
	}
}

/**
 * Fetches analytics data and refreshes the chart currently on screen.
 *
 * @param {string} set Analytics data set to request, e.g. `topics`
 * @param {string} [units] Bucket size, either `hours` or `days`
 * @param {number} [until] End of the range as a timestamp
 * @param {number} [amount] Number of buckets to fetch
 * @returns {Promise<Chart>} The updated chart instance
 */
async function update(
	set,
	units = ajaxify.data.query.units || DEFAULT_UNITS,
	until = ajaxify.data.query.until,
	amount = ajaxify.data.query.count
) {
	if (!currentChart) {
		throw new Error('[[error:invalid-data]]');
	}

	const dataset = await api.get(`/admin/analytics/${set}`, { units, until, amount });
	const labels = units === 'days' ? utils.getDaysArray(until, amount) : utils.getHoursArray();

	// `xLabels` is kept alongside `labels` for consumers of the chart data
	currentChart.data.xLabels = labels;
	currentChart.data.labels = labels;
	currentChart.data.datasets[0].data = dataset;
	currentChart.update();

	// Update address bar and "View as JSON" button url
	const query = $.param({
		units: units || DEFAULT_UNITS,
		until: until,
		count: amount,
	});
	$('#view-as-json').attr(
		'href',
		`${config.relative_path}/api/v3/admin/analytics/${ajaxify.data.set}?${query}`
	);

	const url = ajaxify.removeRelativePath(ajaxify.data.url.slice(1));
	ajaxify.updateHistory(`${url}?${query}`, true);
	hooks.fire('action:admin.dashboard.updateGraph', {
		graph: currentChart,
	});

	return currentChart;
}
