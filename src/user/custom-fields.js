'use strict';

const validator = require('validator');

const meta = require('../meta');
const db = require('../database');
const utils = require('../utils');
const tx = require('../translator');

const CustomFields = module.exports;

CustomFields.getKeys = async function () {
	return await db.getSortedSetRange('user-custom-fields', 0, -1);
};

CustomFields.getFields = async function () {
	const keys = await CustomFields.getKeys();
	return (await db.getObjects(keys.map(k => `user-custom-field:${k}`))).filter(Boolean);
};

CustomFields.setFields = async function (fields) {
	const keys = await CustomFields.getKeys();
	await db.delete('user-custom-fields');
	await db.deleteAll(keys.map(k => `user-custom-field:${k}`));

	await db.sortedSetAdd(
		'user-custom-fields',
		fields.map((f, i) => i),
		fields.map(f => f.key)
	);
	await db.setObjectBulk(
		fields.map(field => [`user-custom-field:${field.key}`, field])
	);
};

CustomFields.getOptions = function (field) {
	const options = field && field['select-options'];
	return options ? String(options).split('\n').filter(Boolean) : [];
};

CustomFields.parseValue = function (field, value) {
	if (field.type !== 'select-multi') {
		return value;
	}

	try {
		const values = JSON.parse(String(value || '[]'));
		return Array.isArray(values) ? values : null;
	} catch {
		return null;
	}
};

CustomFields.validate = function (field, value) {
	const { type } = field;

	if (typeof value === 'string' && value.length > 255) {
		throw new Error(tx.compile(
			'error:custom-user-field-value-too-long', field.name
		));
	}

	const isUrl = value && validator.isURL(String(value).trim(), {
		require_protocol: true,
		require_valid_protocol: true,
		require_tld: true,
	});

	const throwValidationError = (key, ...args) => {
		throw new Error(tx.compile(`error:${key}`, field.name, ...args));
	};

	if (value && type === 'input-number' && !utils.isNumber(value)) {
		throwValidationError('custom-user-field-invalid-number');
	} else if (value && type === 'input-text' && isUrl) {
		throwValidationError('custom-user-field-invalid-text');
	} else if (value && type === 'input-date' && !validator.isDate(value)) {
		throwValidationError('custom-user-field-invalid-date');
	} else if (value && type === 'input-link' && !isUrl) {
		throwValidationError('custom-user-field-invalid-link');
	} else if (type === 'select') {
		const opts = CustomFields.getOptions(field);
		if (!opts.includes(value) && value !== '') {
			throwValidationError('custom-user-field-select-value-invalid');
		}
	} else if (type === 'select-multi') {
		const opts = CustomFields.getOptions(field);
		const values = CustomFields.parseValue(field, value);
		if (!values || !values.every(v => opts.includes(v))) {
			throwValidationError('custom-user-field-select-value-invalid');
		}
	}
};

CustomFields.hideCustomFields = async function (callerUID, userData, isPrivileged, allFields) {
	allFields.forEach((field) => {
		const isVisible = CustomFields.isFieldVisible(field, callerUID, userData, isPrivileged);
		if (!isVisible) {
			userData[field.key] = undefined;
		}
	});
};

CustomFields.isFieldVisible = function (field, callerUID, userData, isPrivileged) {
	const visibility = field.visibility || 'all';
	callerUID = String(callerUID);
	const isSelf = callerUID === String(userData.uid);
	const visibilityCheck = isPrivileged || isSelf || visibility === 'all' ||
		(
			visibility === 'loggedin' &&
			callerUID !== '0' &&
			callerUID !== '-1'
		);
	const minRep = field['min:rep'] || 0;
	const repCheck = userData.reputation >= minRep || meta.config['reputation:disabled'];
	return visibilityCheck && repCheck;
};
