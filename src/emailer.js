'use strict';

const winston = require('winston');
const nconf = require('nconf');
const Benchpress = require('benchpressjs');
const nodemailer = require('nodemailer');
const wellKnownServices = require('nodemailer/lib/well-known/services');
const { htmlToText } = require('html-to-text');
const path = require('path');
const fs = require('fs');
const _ = require('lodash');
const jwt = require('jsonwebtoken');

const db = require('./database');
const User = require('./user');
const Plugins = require('./plugins');
const meta = require('./meta');
const translator = require('./translator');
const languages = require('./languages');
const pubsub = require('./pubsub');
const file = require('./file');

const viewsDir = nconf.get('views_dir');
const Emailer = module.exports;

let prevConfig;
let app;

Emailer.fallbackNotFound = false;

Emailer.transports = {
	sendmail: nodemailer.createTransport({
		sendmail: true,
		newline: 'unix',
	}),
	smtp: undefined,
};

/**
 * List of well-known email services supported by nodemailer
 * @returns {string[]} Array of service names
 */
Emailer.listServices = () => Object.keys(wellKnownServices);
Emailer._defaultPayload = {};

// Email template constants
const ALLOWED_TEMPLATES = ['verify-email', 'welcome', 'registration_accepted', 'reset', 'reset_notify'];
const UNSUBSCRIBABLE_TEMPLATES = ['digest', 'notification'];

/**
 * Check if any SMTP settings have changed compared to previous configuration
 * @param {Object} config - The current configuration object
 * @returns {boolean} True if any settings have changed
 */
const smtpSettingsChanged = (config) => {
	const settings = [
		'email:smtpTransport:enabled',
		'email:smtpTransport:pool',
		'email:smtpTransport:user',
		'email:smtpTransport:pass',
		'email:smtpTransport:service',
		'email:smtpTransport:port',
		'email:smtpTransport:host',
		'email:smtpTransport:security',
	];
	return settings.some(key => config.hasOwnProperty(key) && config[key] !== prevConfig[key]);
};

const getHostname = () => {
	const configUrl = nconf.get('url');
	return new URL(configUrl).hostname;
};

/**
 * Build custom email templates when configuration changes
 * @param {Object} config - The current configuration object
 * @returns {Promise<void>}
 */
const buildCustomTemplates = async (config) => {
	try {
		const customEmailProps = Object
			.keys(config)
			.filter(prop => prop.startsWith('email:custom:'))
			.map(key => key.split(':')[2]);

		if (!customEmailProps.length) {
			return;
		}

		const [templates, allPaths] = await Promise.all([
			Emailer.getTemplates(config),
			file.walk(viewsDir),
		]);

		const templatesToBuild = templates.filter(template => customEmailProps.includes(template.path));
		const paths = _.fromPairs(allPaths.map((p) => {
			const relative = path.relative(viewsDir, p).replace(/\\/g, '/');
			return [relative, p];
		}));

		await Promise.all(templatesToBuild.map(async (template) => {
			const source = await meta.templates.processImports(paths, template.path, template.text);
			const compiled = await Benchpress.precompile(source, { filename: template.path });
			await fs.promises.writeFile(template.fullpath.replace(/\.tpl$/, '.js'), compiled);
		}));

		Benchpress.flush();
		winston.verbose('[emailer] Built custom email templates');
	} catch (err) {
		winston.error(`[emailer] Failed to build custom email templates: ${err.message}`);
	}
};

/**
 * Get all available email templates
 * @param {Object} config - The current configuration object
 * @returns {Promise<Array>} Array of template objects with path, fullpath, text, original, and isCustom properties
 */
Emailer.getTemplates = async (config) => {
	const emailsPath = path.join(viewsDir, 'emails');
	let emails = await file.walk(emailsPath);
	emails = emails.filter(email => !email.endsWith('.js'));

	const templates = await Promise.all(emails.map(async (emailPath) => {
		const templatePath = emailPath.replace(emailsPath, '').slice(1).replace('.tpl', '');
		const original = await fs.promises.readFile(emailPath, 'utf8');

		return {
			path: templatePath,
			fullpath: emailPath,
			text: config[`email:custom:${templatePath}`] || original,
			original: original,
			isCustom: !!config[`email:custom:${templatePath}`],
		};
	}));
	return templates;
};

/**
 * Set up the fallback transport (sendmail or SMTP) based on configuration
 * @param {Object} config - The configuration object
 */
Emailer.setupFallbackTransport = (config) => {
	winston.verbose('[emailer] Setting up fallback transport');
	if (parseInt(config['email:smtpTransport:enabled'], 10) === 1) {
		Emailer.fallbackTransport = Emailer.createSmtpTransport(config);
	} else {
		Emailer.fallbackTransport = Emailer.transports.sendmail;
	}
};

/**
 * Create an SMTP transport based on configuration
 * @param {Object} config - The configuration object
 * @returns {Object} nodemailer transport instance
 */
Emailer.createSmtpTransport = (config) => {
	const smtpOptions = {
		name: getHostname(),
		pool: config['email:smtpTransport:pool'],
	};

	const user = config['email:smtpTransport:user'];
	const pass = config['email:smtpTransport:pass'];
	if (user || pass) {
		smtpOptions.auth = {
			user,
			pass,
		};
	}

	if (config['email:smtpTransport:service'] === 'nodebb-custom-smtp') {
		smtpOptions.port = config['email:smtpTransport:port'];
		smtpOptions.host = config['email:smtpTransport:host'];

		const security = config['email:smtpTransport:security'];
		if (security === 'NONE') {
			smtpOptions.secure = false;
			smtpOptions.requireTLS = false;
			smtpOptions.ignoreTLS = true;
		} else if (security === 'STARTTLS') {
			smtpOptions.secure = false;
			smtpOptions.requireTLS = true;
			smtpOptions.ignoreTLS = false;
		} else {
			smtpOptions.secure = true;
			smtpOptions.requireTLS = true;
			smtpOptions.ignoreTLS = false;
		}
	} else {
		smtpOptions.service = String(config['email:smtpTransport:service']);
	}
	if (config['email:smtpTransport:allow-self-signed']) {
		smtpOptions.tls = {
			rejectUnauthorized: false,
		};
	}
	return nodemailer.createTransport(smtpOptions);
};

/**
 * Register the emailer with the Express application
 * @param {Object} expressApp - The Express application instance
 * @returns {Object} The Emailer module
 */
Emailer.registerApp = (expressApp) => {
	app = expressApp;

	let logo = null;
	if (meta.config && meta.config.hasOwnProperty('brand:emailLogo')) {
		logo = (!meta.config['brand:emailLogo'].startsWith('http') ? nconf.get('url') : '') + meta.config['brand:emailLogo'];
	}

	Emailer._defaultPayload = {
		url: nconf.get('url'),
		site_title: meta.config.title || 'NodeBB',
		logo: {
			src: logo,
			height: meta.config['brand:emailLogo:height'],
			width: meta.config['brand:emailLogo:width'],
		},
	};

	Emailer.setupFallbackTransport(meta.config);
	buildCustomTemplates(meta.config);

	// need to shallow clone the config object
	// otherwise prevConfig holds reference to meta.config object,
	// which is updated before the pubsub handler is called
	prevConfig = { ...meta.config };

	pubsub.on('config:update', (config) => {
		if (!config) {
			return;
		}

		// Update default payload if logo-related settings change
		if (meta.config) {
			if (config.hasOwnProperty('brand:emailLogo')) {
				Emailer._defaultPayload.logo.src = config['brand:emailLogo'];
			}
			if (config.hasOwnProperty('brand:emailLogo:height')) {
				Emailer._defaultPayload.logo.height = config['brand:emailLogo:height'];
			}
			if (config.hasOwnProperty('brand:emailLogo:width')) {
				Emailer._defaultPayload.logo.width = config['brand:emailLogo:width'];
			}
		}

		if (smtpSettingsChanged(config)) {
			Emailer.setupFallbackTransport(config);
		}
		buildCustomTemplates(config);

		prevConfig = { ...prevConfig, ...config };
	});

	return Emailer;
};

/**
 * Send an email to a user based on a template
 * @param {string} template - The email template name
 * @param {number} uid - The user ID
 * @param {Object} params - Additional parameters to pass to the template
 * @returns {Promise<void>}
 */
Emailer.send = async (template, uid, params) => {
	if (!app) {
		throw Error('[emailer] App not ready!');
	}

	let userData = await User.getUserFields(uid, ['email', 'username', 'email:confirmed', 'banned']);

	// 'welcome', 'verify-email' & 'registration_accepted' explicitly use passed-in email address
	if (ALLOWED_TEMPLATES.includes(template)) {
		userData.email = params.email;
	} else if (meta.config && meta.config.includeUnverifiedEmails && !userData.email) {
		const code = await db.get(`confirm:byUid:${uid}`);
		const confirmObj = code ? await db.getObject(`confirm:${code}`) : null;
		if (confirmObj && confirmObj.email) {
			userData.email = confirmObj.email;
		}
	}

	({ template, userData, params } = await Plugins.hooks.fire('filter:email.prepare', { template, uid, userData, params }));

	if (userData.banned && !meta.config?.sendEmailToBanned && template !== 'banned') {
		winston.warn(`[emailer/send] User ${userData.username} (uid: ${uid}) is banned; not sending email due to system config.`);
		return;
	}

	if (!userData || !userData.email) {
		if (process.env.NODE_ENV === 'development') {
			winston.warn(`uid : ${uid} has no email, not sending "${template}" email.`);
		}
		return;
	}

	if (!meta.config?.includeUnverifiedEmails && !userData['email:confirmed'] && !ALLOWED_TEMPLATES.includes(template)) {
		if (process.env.NODE_ENV === 'development') {
			winston.warn(`uid : ${uid} (${userData.email}) has not confirmed email, not sending "${template}" email.`);
		}
		return;
	}
	const userSettings = await User.getSettings(uid);
	params = { ...Emailer._defaultPayload, ...params };
	params.uid = uid;
	params.username = userData.username;
	params.displayname = userData.displayname;
	params.rtl = translator.languageDirection(userSettings.userLang) === 'rtl';

	await Emailer.sendToEmail(template, userData.email, userSettings.userLang, params);
};

/**
 * Send an email directly to a specific email address
 * @param {string} template - The email template name
 * @param {string} email - The recipient email address
 * @param {string} language - The language code for the email
 * @param {Object} params - Additional parameters to pass to the template
 * @returns {Promise<void>}
 */
Emailer.sendToEmail = async (template, email, language, params) => {
	const lang = language || meta.config?.defaultLang || 'en-GB';
	const unsubscribable = UNSUBSCRIBABLE_TEMPLATES;

	params = { ...Emailer._defaultPayload, ...params };
	if (!params.hasOwnProperty('rtl')) {
		params.rtl = translator.languageDirection(lang) === 'rtl';
	}

	// Digests and notifications can be one-click unsubbed
	let payload = {
		template: template,
		uid: params.uid,
	};

	if (unsubscribable.includes(template)) {
		if (template === 'notification') {
			payload.type = params.notification?.type;
		}
		payload = jwt.sign(payload, nconf.get('secret'), {
			expiresIn: '30d',
		});

		const unsubUrl = [nconf.get('url'), 'email', 'unsubscribe', payload].join('/');
		params.headers = {
			'List-Id': `<${[template, params.uid, getHostname()].join('.')}>`,
			'List-Unsubscribe': `<${unsubUrl}>`,
			'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
			...params.headers,
		};
		params.unsubUrl = unsubUrl;
	}

	const { cancel } = await Plugins.hooks.fire('filter:email.cancel', {
		cancel: false,
		template: template,
		params: params,
	});

	if (cancel) {
		const logTarget = params.uid ? `uid ${params.uid}` : email;
		winston.verbose(`[emailer] "${template}" email to ${logTarget} was cancelled by a plugin.`);
		return;
	}

	const result = await Plugins.hooks.fire('filter:email.params', {
		template: template,
		email: email,
		language: lang,
		params: params,
	});

	template = result.template;
	email = result.email;
	params = result.params;

	const [html, subject] = await Promise.all([
		Emailer.renderAndTranslate(template, params, result.language),
		translator.translate(params.subject, result.language),
	]);

	const data = await Plugins.hooks.fire('filter:email.modify', {
		_raw: params,
		to: email,
		from: meta.config?.['email:from'] || `no-reply@${getHostname()}`,
		from_name: meta.config?.['email:from_name'] || 'NodeBB',
		subject: `[${meta.config?.title || 'NodeBB'}] ${_.unescape(subject)}`,
		html: html,
		plaintext: htmlToText(html, {
			tags: { img: { format: 'skip' } },
		}),
		template: template,
		uid: params.uid,
		pid: params.pid,
		fromUid: params.fromUid,
		rtl: params.rtl,
	});
	const usingFallback = !Plugins.hooks.hasListeners('filter:email.send') &&
		!Plugins.hooks.hasListeners('static:email.send');
	try {
		if (Plugins.hooks.hasListeners('static:email.send')) {
			await Plugins.hooks.fire('static:email.send', data);
		} else {
			await Emailer.sendViaFallback(data);
		}
	} catch (err) {
		if (err.code === 'ENOENT' && usingFallback) {
			Emailer.fallbackNotFound = true;
			throw new Error('[[error:sendmail-not-found]]');
		}
		throw err;
	}
};

/**
 * Send email via the fallback transport (sendmail or SMTP)
 * @param {Object} data - The email data to send
 * @returns {Promise<void>}
 */
Emailer.sendViaFallback = async (data) => {
	data.text = data.plaintext;
	delete data.plaintext;

	data.from = {
		name: data.from_name,
		address: data.from,
	};
	delete data.from_name;
	await Emailer.fallbackTransport.sendMail(data);
};

/**
 * Render and translate an email template
 * @param {string} template - The template name
 * @param {Object} params - Parameters to pass to the template
 * @param {string} lang - The language code
 * @returns {Promise<string>} The rendered HTML
 */
Emailer.renderAndTranslate = async (template, params, lang) => {
	const html = await app.renderAsync(`emails/${template}`, {
		...params,
		_i18n: languages.getFull(lang),
	});
	return html;
};

require('./promisify')(Emailer, ['transports']);
