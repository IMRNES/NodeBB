/**
 * @fileoverview Tests to verify that all mounted routes have corresponding
 * OpenAPI schema definitions.
 * @see {@link https://github.com/NodeBB/NodeBB/issues/11761}
 */

'use strict';

const assert = require('assert');
const path = require('path');
const nconf = require('nconf');
const _ = require('lodash');
const SwaggerParser = require('@apidevtools/swagger-parser');

const db = require('../mocks/databasemock');

let readApi;
let writeApi;

const EXCLUSION_PREFIXES = [
	'/api/admin/plugins', '/api/compose', '/debug',
	'/api/user/{userslug}/theme', // from persona
];

/**
 * Parses and dereferences an OpenAPI specification file
 * @param {string} filePath - Path to the OpenAPI YAML file
 * @returns {Promise<Object>} Dereferenced OpenAPI specification
 */
async function parseApi(filePath) {
	const window = global.window;
	try {
		delete global.window;
		return await SwaggerParser.dereference(filePath);
	} finally {
		global.window = window;
	}
}

/**
 * Extracts all route paths from an Express router's internal structure
 * @param {Array} stack - Express router stack
 * @param {string} prefix - Current path prefix
 * @returns {Array} Array of route objects with method and path
 */
function buildPaths(stack, prefix) {
	const effectivePrefix = prefix === nconf.get('relative_path') ? '' : prefix;

	const paths = stack.map((route) => {
		if (route.route && route.route.path && typeof route.route.path === 'string') {
			// Only include API routes if no effective prefix
			if (!effectivePrefix && !route.route.path.startsWith('/api/')) {
				return null;
			}

			return {
				method: Object.keys(route.route.methods)[0],
				path: (effectivePrefix || '') + route.route.path,
			};
		} else if (route.name === 'router') {
			const prefix = route.regexp.toString().replace('/^', '').replace('\\/?(?=\\/|$)/i', '').replace(/\\\//g, '/');
			return buildPaths(route.handle.stack, prefix);
		}

		// Filter out non-route middleware and error handlers
		return null;
	});

	return _.flatten(paths);
}

describe('routes', function () {
	before(async function () {
		const readApiPath = path.resolve(__dirname, '../../public/openapi/read.yaml');
		const writeApiPath = path.resolve(__dirname, '../../public/openapi/write.yaml');
		readApi = await parseApi(readApiPath);
		writeApi = await parseApi(writeApiPath);
	});

	it('should grab all mounted routes and ensure a schema exists', async function () {
		const webserver = require('../../src/webserver');

		let paths = buildPaths(webserver.app._router.stack).filter(Boolean).map((pathObj) => {
			pathObj.path = pathObj.path.replace(/\/:([^\\/]+)/g, '/{$1}');
			return pathObj;
		});

		paths = paths.filter(pathObj =>
			pathObj.method !== '_all' &&
			!EXCLUSION_PREFIXES.some(prefix => pathObj.path.startsWith(prefix))
		);

		paths.forEach((pathObj) => {
			describe(`${pathObj.method.toUpperCase()} ${pathObj.path}`, function () {
				it('should be defined in schema docs', function () {
					let schema = readApi;
					if (pathObj.path.startsWith('/api/v3')) {
						schema = writeApi;
						pathObj.path = pathObj.path.replace('/api/v3', '');
					}

					// Skip non-GET routes in Read API
					if (schema === readApi && pathObj.method !== 'get') {
						return;
					}

					const normalizedPath = pathObj.path.replace(/\/:([^\\/]+)/g, '/{$1}').replace(/\?/g, '');
					assert(schema.paths.hasOwnProperty(normalizedPath), `${pathObj.path} is not defined in schema docs`);
					assert(schema.paths[normalizedPath].hasOwnProperty(pathObj.method), `${pathObj.path} was found in schema docs, but ${pathObj.method.toUpperCase()} method is not defined`);
				});
			});
		});
	});
});
