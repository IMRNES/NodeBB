'use strict';

define('chat', [
	'components', 'taskbar', 'translator', 'hooks', 'modals', 'alerts', 'api', 'scrollStop', 'resizable', 'helpers',
], function (components, taskbar, translator, hooks, modals, alerts, api, scrollStop, resizable, helpers) {
	const Chat = {};

	/**
	 * Opens a chat room, either in a modal window or by navigating to the full
	 * chat page when modals are disabled or the viewport is mobile-sized.
	 *
	 * @param {number|string} roomId Chat room to open
	 * @param {number|string} [uid] User the chat should be opened as, defaults to the current user
	 */
	Chat.openChat = function (roomId, uid) {
		if (!app.user.uid) {
			return alerts.error('[[error:not-logged-in]]');
		}

		function loadAndPosition(chatModal) {
			Chat.load(chatModal.attr('data-uuid'));
			Chat.position(chatModal);
			Chat.focusInput(chatModal);
		}

		hooks.fire('filter:chat.openChat', {
			modal: true,
			roomId: roomId,
			uid: uid,
		}).then((hookData) => {
			if (!hookData.modal || utils.isMobile()) {
				return ajaxify.go(`/chats/${roomId}`);
			}
			if (Chat.modalExists(roomId)) {
				loadAndPosition(Chat.getModal(roomId));
			} else {
				api.get(`/chats/${roomId}`, {
					uid: uid || app.user.uid,
				}).then((roomData) => {
					roomData.users = roomData.users.filter(function (user) {
						return user && parseInt(user.uid, 10) !== parseInt(app.user.uid, 10);
					});
					roomData.uid = uid || app.user.uid;
					roomData.isSelf = true;
					Chat.createModal(roomData, loadAndPosition);
				}).catch(alerts.error);
			}
		});
	};

	/**
	 * Starts a new chat room with another user, asking for confirmation first if
	 * that user does not want to be disturbed.
	 *
	 * @param {number|string} touid Uid of the user to chat with
	 * @param {Function} [callback] Called with `(null, roomId)` once the room exists
	 */
	Chat.newChat = function (touid, callback) {
		function createChat() {
			api.post(`/chats`, {
				uids: [touid],
			}).then(({ roomId }) => {
				if (!ajaxify.data.template.chats) {
					Chat.openChat(roomId);
				} else {
					ajaxify.go('chats/' + roomId);
				}

				callback(null, roomId);
			}).catch(alerts.error);
		}

		callback = callback || function () { };

		if (!app.user.uid) {
			return alerts.error('[[error:not-logged-in]]');
		}

		if (parseInt(touid, 10) === parseInt(app.user.uid, 10)) {
			return alerts.error('[[error:cant-chat-with-yourself]]');
		}

		// Skip dnd check for remote users
		if (!utils.isNumber(touid)) {
			return createChat();
		}

		api.get(`/users/${touid}/status`).then(({ status }) => {
			if (status !== 'dnd') {
				return createChat();
			}

			modals.confirm('[[modules:chat.confirm-chat-with-dnd-user]]', function (ok) {
				if (ok) {
					createChat();
				}
			});
		}).catch(alerts.error);
	};

	/**
	 * Fetches the most recent chats and renders them into the chat dropdown.
	 *
	 * @param {JQuery} chatsListEl Container the dropdown list is rendered into
	 */
	Chat.loadChatsDropdown = function (chatsListEl) {
		api.get('/chats', {
			uid: app.user.uid,
			after: 0,
		}).then((data) => {
			const rooms = data.rooms.map((room) => {
				if (room && room.teaser) {
					room.teaser.timeagoLong = $.timeago(new Date(parseInt(room.teaser.timestamp, 10)));
				}
				return room;
			});

			translator.toggleTimeagoShorthand(async function () {
				rooms.forEach((room) => {
					if (room && room.teaser) {
						room.teaser.timeago = $.timeago(new Date(parseInt(room.teaser.timestamp, 10)));
						room.teaser.timeagoShort = room.teaser.timeago;
					}
				});

				translator.toggleTimeagoShorthand();
				const html = await app.parseAndTranslate('partials/chats/dropdown', { rooms: rooms });
				const listEl = chatsListEl.get(0);

				const prevFirstRoom = listEl.querySelector('[data-roomid]');
				const prevFirstRoomKey = getRoomKey(prevFirstRoom);
				chatsListEl.find('*').not('.navigation-link').remove();
				chatsListEl.prepend(html);
				const firstRoom = listEl.querySelector('[data-roomid]');
				const firstRoomKey = getRoomKey(firstRoom);
				if (prevFirstRoomKey && prevFirstRoomKey !== firstRoomKey) {
					listEl.scrollTop = 0;
				}
				chatsListEl.off('click').on('click', '[data-roomid]', function (ev) {
					if (['.user-link', '.mark-read'].some(className => ev.target.closest(className))) {
						return;
					}
					const roomId = $(this).attr('data-roomid');
					if (!ajaxify.currentPage.match(/^chats\//)) {
						Chat.openChat(roomId);
					} else {
						ajaxify.go('user/' + app.user.userslug + '/chats/' + roomId);
					}
				});

				listEl.removeEventListener('click', onMarkReadClicked);
				listEl.addEventListener('click', onMarkReadClicked);

				$('[component="chats/mark-all-read"]').off('click').on('click', async function () {
					const chatEls = document.querySelectorAll('[component="chat/list"] [data-roomid]');
					await Promise.all(Array.prototype.map.call(chatEls, async (el) => {
						const roomId = el.getAttribute('data-roomid');
						await api.del(`/chats/${roomId}/state`);
						if (ajaxify.data.template.chats) {
							Chat.markChatElUnread($(el), false);
						}
					}));
				});
			});
		}).catch(alerts.error);
	};

	/**
	 * Builds a comparable key for a rendered chat room element, combining its
	 * room id with whether it is currently marked unread.
	 *
	 * @param {Element} [roomEl] First rendered chat room element, if any
	 * @returns {string} Key for the element, falsy when the element is absent
	 */
	function getRoomKey(roomEl) {
		return roomEl && `${roomEl.getAttribute('data-roomid')}:${roomEl.classList.contains('unread')}`;
	}

	/**
	 * Click handler for the "mark read" control on a chat room entry.
	 *
	 * @param {Event} e Click event
	 */
	function onMarkReadClicked(e) {
		const subselector = e.target.closest('.mark-read');
		if (!subselector) {
			return;
		}

		e.stopPropagation();
		const chatEl = e.target.closest('[data-roomid]');
		Chat.toggleReadState(chatEl);
	}

	/**
	 * Toggles the read/unread state of a chat room, reverting the visual change
	 * if the request fails.
	 *
	 * @param {Element} chatEl Chat room element carrying the `data-roomid` attribute
	 */
	Chat.toggleReadState = function (chatEl) {
		const state = !chatEl.classList.contains('unread'); // this is the new state
		const roomId = chatEl.getAttribute('data-roomid');
		api[state ? 'put' : 'del'](`/chats/${roomId}/state`, {}).catch((err) => {
			alerts.error(err);

			// Revert on failure
			Chat.markChatElUnread($(chatEl), !state);
		});

		// Immediate feedback
		Chat.markChatElUnread($(chatEl), state);
	};

	/**
	 * Checks whether a message was sent by a user the current user has blocked.
	 *
	 * @param {number|string} fromUid Uid of the message sender
	 * @returns {boolean} `true` when the sender is blocked by the current user
	 */
	Chat.isFromBlockedUser = function (fromUid) {
		return app.user?.blocks?.includes(String(fromUid)) ?? false;
	};

	/**
	 * Checks whether the current page is the chat page of the given room.
	 *
	 * @param {number|string} roomId Room to compare against the room currently being viewed
	 * @returns {boolean} `true` when the given room is the one on screen
	 */
	Chat.isLookingAtRoom = function (roomId) {
		return ajaxify.data.template.chats && parseInt(ajaxify.data.roomId, 10) === parseInt(roomId, 10);
	};

	/**
	 * Toggles the unread indicator of a chat room element.
	 *
	 * @param {JQuery} roomEl Chat room element
	 * @param {boolean} unread Whether the room should be shown as unread
	 */
	Chat.markChatElUnread = function (roomEl, unread) {
		if (roomEl.length > 0) {
			roomEl.toggleClass('unread', unread);
			const markEl = roomEl.find('.mark-read');
			if (markEl.length) {
				markEl.find('.read').toggleClass('hidden', unread);
				markEl.find('.unread').toggleClass('hidden', !unread);
			}
		}
	};

	/**
	 * Handles an incoming chat message, appending it to the room modal when that
	 * room is currently open.
	 *
	 * @param {object} data Socket payload describing the new message
	 */
	Chat.onChatMessageReceived = function (data) {
		if (Chat.isFromBlockedUser(data.fromUid)) {
			return;
		}
		if (Chat.modalExists(data.roomId)) {
			const modal = Chat.getModal(data.roomId);
			const newMessage = parseInt(modal.attr('new-message'), 10) === 1;
			data.self = parseInt(app.user.uid, 10) === parseInt(data.fromUid, 10) ? 1 : 0;
			if (!newMessage) {
				modal.attr('new-message', data.self === 0 ? 1 : 0);
			}
			data.message.self = data.self;
			data.message.timestampISO = utils.toISOString(Math.min(Date.now(), data.message.timestamp));
			addMessageToModal(data);
		}
	};

	/**
	 * Appends a message to an open room modal, updating the taskbar and unread
	 * indicators as needed.
	 *
	 * @param {object} data Socket payload describing the new message
	 */
	function addMessageToModal(data) {
		const modal = Chat.getModal(data.roomId);
		const username = data.message.fromUser.username;
		const isSelf = data.self === 1;
		require(['forum/chats/messages'], function (ChatsMessages) {
			// don't add if already added
			if (!modal.find('[data-mid="' + data.message.messageId + '"]').length) {
				ChatsMessages.appendChatMessage(modal.find('[component="chat/message/content"]'), data.message);
			}

			if (modal.is(':visible')) {
				taskbar.updateActive(modal.attr('data-uuid'));
				if (ChatsMessages.isAtBottom(modal.find('[component="chat/message/content"]'))) {
					ChatsMessages.scrollToBottomAfterImageLoad(modal.find('[component="chat/message/content"]'));
				}
			} else if (!ajaxify.data.template.chats) {
				Chat.toggleNew(modal.attr('data-uuid'), true, true);
			}

			if (!isSelf && (!modal.is(':visible') || !app.isFocused)) {
				taskbar.push('chat', modal.attr('data-uuid'), {
					title: '[[modules:chat.chatting-with]] ' + (data.roomName || username),
					touid: data.message.fromUser.uid,
					roomId: data.roomId,
					isSelf: false,
				});
			}
		});
	}

	/**
	 * Handles a room rename, updating the modal title and taskbar entry.
	 *
	 * @param {object} data Socket payload with the new room name
	 */
	Chat.onRoomRename = function (data) {
		const modal = Chat.getModal(data.roomId);
		const titleEl = modal.find('[component="chat/room/name"]');
		const icon = titleEl.attr('data-icon');
		Chat.updateRoomName(titleEl, icon, data.newName, data.chatWithMessage);
		taskbar.update('chat', modal.attr('data-uuid'), {
			title: helpers.escape(data.newName),
		});
		hooks.fire('action:chat.renamed', Object.assign(data, {
			modal: modal,
		}));
	};

	/**
	 * Updates the title of a chat room modal.
	 *
	 * @param {JQuery} titleEl Element holding the room name
	 * @param {string} icon Font Awesome icon shown in front of the name
	 * @param {string} [newName] New room name, falls back to the "chatting with" message
	 * @param {string} [chatWithMessage] Translated fallback title
	 */
	Chat.updateRoomName = function (titleEl, icon, newName, chatWithMessage) {
		if (titleEl.length) {
			titleEl.translateHtml(
				newName ?
					`<i class="fa ${helpers.escape(icon)} text-muted"></i> ${helpers.escape(newName)}` :
					chatWithMessage
			);
		}
	};

	/**
	 * Handles a typing notification from another user.
	 *
	 * @param {object} data Socket payload with `uid`, `username` and `typing` state
	 */
	Chat.onUserTyping = function (data) {
		if (data.uid === app.user.uid || Chat.isFromBlockedUser(data.uid)) {
			return;
		}
		const modal = Chat.getModal(data.roomId);
		if (modal.length) {
			Chat.updateTypingUserList(modal, data);
		}
	};

	/**
	 * Renders the list of users currently typing in a room.
	 *
	 * @param {JQuery} container Modal or composer containing the typing indicator
	 * @param {object} data Socket payload with `uid`, `username` and `typing` state
	 */
	Chat.updateTypingUserList = async function (container, { uid, username, typing }) {
		const typingEl = container.find(`[component="chat/composer/typing"]`);
		const typingUsersList = typingEl.find('[component="chat/composer/typing/users"]');
		const userEl = typingUsersList.find(`[data-uid="${uid}"]`);

		if (typing && !userEl.length) {
			$(`<div/>`).attr('data-uid', uid)
				.text(username)
				.appendTo(typingUsersList);
		} else if (!typing && userEl.length) {
			userEl.remove();
		}

		const usernames = [];
		typingUsersList.children().each((i, el) => {
			usernames.push(translator.escape($(el).text()));
		});

		const totalTyping = usernames.length;
		const typingTextEl = typingEl.find('[component="chat/composer/typing/text"]');
		if (totalTyping) {
			const key = `modules:chat.user-typing-${totalTyping > 3 ? 'n' : totalTyping}`;
			const args = [];
			if (totalTyping > 3) {
				args.push(usernames[0], usernames[1], totalTyping - 2);
			} else {
				args.push(...usernames);
			}
			typingTextEl.html(await translator.translateKey(key, args));
		}
		typingTextEl.toggleClass('hidden', !usernames.length);
	};

	/**
	 * Retrieves the modal element of a chat room.
	 *
	 * @param {number|string} roomId Chat room whose modal is requested
	 * @returns {JQuery} Modal element, empty when the room has no modal
	 */
	Chat.getModal = function (roomId) {
		return $(`#chat-modal-${roomId}`);
	};

	/**
	 * Retrieves a chat modal by its taskbar uuid.
	 *
	 * @param {string} uuid Unique id assigned to the modal
	 * @returns {JQuery} Modal element, empty when no modal has that uuid
	 */
	function getModalByUuid(uuid) {
		return $(`.chat-modal[data-uuid="${uuid}"]`);
	}

	/**
	 * Raises a chat modal above the other open chat modals.
	 *
	 * @param {JQuery} chatModal Modal to bring to the front
	 */
	function bringModalToFront(chatModal) {
		const chatModals = $('.chat-modal');
		if (chatModals.length <= 1) {
			return;
		}
		chatModals.css('zIndex', '');
		const zIndex = parseInt(chatModal.css('zIndex'), 10) || 1055;
		chatModal.css('zIndex', zIndex + 1);
	}

	/**
	 * Checks whether a chat room modal is currently open.
	 *
	 * @param {number|string} roomId Chat room to look for
	 * @returns {boolean} `true` when the room has an open modal
	 */
	Chat.modalExists = function (roomId) {
		return Chat.getModal(roomId).length !== 0;
	};

	/**
	 * Clears the unread marker of a room modal once the user interacts with it.
	 *
	 * @param {JQuery} chatModal Chat room modal
	 * @param {number|string} roomId Chat room the modal belongs to
	 */
	function clearNewMessageOnInteraction(chatModal, roomId) {
		if (parseInt(chatModal.attr('new-message'), 10) === 1) {
			api.del(`/chats/${roomId}/state`, {});
			chatModal.removeAttr('new-message');
		}
	}

	/**
	 * Sets up the chat widget shown in the sidebar of full chat pages.
	 *
	 * @param {number|string} roomId Chat room being displayed
	 * @param {JQuery} chatModal Widget element the handlers are bound to
	 */
	Chat.initWidget = function (roomId, chatModal) {
		require(['forum/chats', 'forum/chats/messages'], function (Chats, ChatsMessages) {
			socket.emit('modules.chats.enter', roomId);
			api.del(`/chats/${roomId}/state`, {});

			chatModal.find('.timeago').timeago();
			chatModal.find('[data-bs-toggle="tooltip"]').tooltip({
				trigger: 'hover', container: '#content',
			});
			ChatsMessages.wrapImagesInLinks(chatModal.find('[component="chat/messages"] .chat-content'));

			scrollStop.apply(chatModal.find('[component="chat/messages"] .chat-content'));

			chatModal.on('mousemove keypress click', function () {
				clearNewMessageOnInteraction(chatModal, roomId);
			});

			Chats.addActionHandlers(chatModal.find('[component="chat/message/window"]'), roomId);
			Chats.addSendHandlers(roomId, chatModal.find('.chat-input'), chatModal.find('[data-action="send"]'));

			Chats.createAutoComplete(roomId, chatModal.find('[component="chat/input"]'));

			Chats.addScrollHandler(roomId, app.user.uid, chatModal.find('[component="chat/message/content"]'));
			Chats.addScrollBottomHandler(roomId, chatModal.find('[component="chat/message/content"]'));
			Chats.addParentHandler(chatModal.find('[component="chat/message/content"]'));
			Chats.addCharactersLeftHandler(chatModal);
			Chats.addTextareaResizeHandler(chatModal);
			Chats.addTypingHandler(chatModal, roomId);
			Chats.addIPHandler(chatModal);
			Chats.addCopyTextLinkHandler(chatModal);
			Chats.addTooltipHandler(chatModal);
			Chats.addUploadHandler(getUploadHandlerOptions(chatModal));

			ChatsMessages.addSocketListeners();

			ChatsMessages.scrollToBottomAfterImageLoad(chatModal.find('.chat-content'));

			hooks.fire('action:chat.loaded', chatModal);
		});
	};

	/**
	 * Creates the modal for a chat room and binds all of its handlers.
	 *
	 * @param {object} data Room data used to render the modal
	 * @param {Function} [callback] Called with the created (or existing) modal element
	 */
	Chat.createModal = function (data, callback) {
		callback = callback || function () {};
		require([
			'forum/chats', 'forum/chats/messages', 'forum/chats/message-search',
		], function (Chats, ChatsMessages, messageSearch) {
			app.parseAndTranslate('chat', data, function (chatModal) {
				const roomId = data.roomId;
				if (Chat.modalExists(roomId)) {
					return callback(Chat.getModal(roomId));
				}
				const uuid = utils.generateUUID();
				let dragged = false;

				chatModal.attr('id', `chat-modal-${roomId}`);
				chatModal.attr('data-roomid', roomId);
				chatModal.attr('data-uuid', uuid);
				chatModal.css('position', 'fixed');
				chatModal.appendTo($('body'));
				bringModalToFront(chatModal);
				chatModal.find('.timeago').timeago();
				chatModal.find('[data-bs-toggle="tooltip"]').tooltip({ trigger: 'hover', container: '#content' });
				ChatsMessages.wrapImagesInLinks(chatModal.find('[component="chat/messages"] .chat-content'));

				scrollStop.apply(chatModal.find('[component="chat/messages"] .chat-content'));

				Chat.position(chatModal);

				makeModalResizeableDraggable(chatModal, uuid);

				chatModal.find('#chat-close-btn').on('click', function () {
					Chat.close(uuid);
				});

				function gotoChats() {
					const text = chatModal.find('[component="chat/input"]').val();
					$(window).one('action:ajaxify.end', function () {
						components.get('chat/main-wrapper').find('[component="chat/input"]').val(text);
					});

					ajaxify.go(`user/${app.user.userslug}/chats/${roomId}`);
					Chat.close(uuid);
				}

				chatModal.find('.modal-header').on('dblclick', gotoChats);
				chatModal.find('button[data-action="maximize"]').on('click', gotoChats);
				chatModal.find('button[data-action="minimize"]').on('click', function () {
					Chat.minimize(chatModal.attr('data-uuid'));
				});

				chatModal.on('mousedown', function () {
					bringModalToFront(chatModal);
				});

				chatModal.on('mouseup', function () {
					taskbar.updateActive(chatModal.attr('data-uuid'));

					if (dragged) {
						dragged = false;
					}
				});

				chatModal.on('mousemove', function (e) {
					if (e.which === 1) {
						dragged = true;
					}
				});

				chatModal.on('mousemove keypress click', function () {
					clearNewMessageOnInteraction(chatModal, roomId);
				});

				Chats.addActionHandlers(chatModal.find('[component="chat/message/window"]'), roomId);
				Chats.addRenameHandler(roomId, chatModal.find('[data-action="rename"]'));
				Chats.addLeaveHandler(roomId, chatModal.find('[data-action="leave"]'));
				Chats.addDeleteHandler(roomId, chatModal.find('[component="chat/controls"] [data-action="delete"]'));
				Chats.addSendHandlers(roomId, chatModal.find('.chat-input'), chatModal.find('[data-action="send"]'));
				Chats.addManageHandler(roomId, chatModal.find('[data-action="manage"]'));

				Chats.createAutoComplete(roomId, chatModal.find('[component="chat/input"]'));

				Chats.addScrollHandler(roomId, data.uid, chatModal.find('[component="chat/message/content"]'));
				Chats.addScrollBottomHandler(roomId, chatModal.find('[component="chat/message/content"]'));
				Chats.addParentHandler(chatModal.find('[component="chat/message/content"]'));
				Chats.addCharactersLeftHandler(chatModal);
				Chats.addTextareaResizeHandler(chatModal);
				Chats.addTypingHandler(chatModal, roomId);
				Chats.addIPHandler(chatModal);
				Chats.addCopyTextLinkHandler(chatModal);
				Chats.addTooltipHandler(chatModal);
				Chats.addUploadHandler(getUploadHandlerOptions(chatModal));

				ChatsMessages.addSocketListeners();
				messageSearch.init(roomId, chatModal);
				Chats.addNotificationSettingHandler(roomId, chatModal);

				taskbar.push('chat', chatModal.attr('data-uuid'), {
					title: '[[modules:chat.chatting-with]] ' + (data.roomName || (data.users.length ? data.users[0].username : '')),
					roomId: data.roomId,
					icon: 'fa-comment',
					state: '',
					isSelf: data.isSelf,
				}, function () {
					taskbar.toggleNew(chatModal.attr('data-uuid'), !data.isSelf);
					hooks.fire('action:chat.loaded', chatModal);

					if (typeof callback === 'function') {
						callback(chatModal);
					}
				});
			});
		});
	};

	/**
	 * Builds the element options shared by every chat upload handler binding.
	 *
	 * @param {JQuery} chatModal Chat room modal
	 * @returns {object} Options for `Chats.addUploadHandler`
	 */
	function getUploadHandlerOptions(chatModal) {
		return {
			dragDropAreaEl: chatModal.find('.modal-content'),
			pasteEl: chatModal,
			uploadFormEl: chatModal.find('[component="chat/upload"]'),
			uploadBtnEl: chatModal.find('[component="chat/upload/button"]'),
			inputEl: chatModal.find('[component="chat/input"]'),
		};
	}

	/**
	 * Makes a chat modal resizable and draggable.
	 *
	 * @param {JQuery} chatModal Modal to make resizable and draggable
	 * @param {string} uuid Unique id assigned to the modal
	 */
	function makeModalResizeableDraggable(chatModal, uuid) {
		resizable.init(chatModal.find('.modal-content'), {
			minWidth: 400,
			minHeight: 250,
			handles: 'n, e, s, w, se, sw',
		});

		chatModal.find('.modal-content').on('resize', function (event) {
			const detail = event.originalEvent ? event.originalEvent.detail : event.detail;
			if (!detail || detail.originalSize.height === detail.size.height) {
				return;
			}

			chatModal.find('.modal-body').css('height', Chat.calculateChatListHeight(chatModal));
		});

		app.loadJQueryUI(() => {
			chatModal.draggable({
				start: function () {
					taskbar.updateActive(uuid);
					chatModal.css({ bottom: 'auto', right: 'auto' });
				},
				stop: function () {
					Chat.focusInput(chatModal);
				},
				distance: 10,
				handle: '.modal-header',
			});
		});
	}

	/**
	 * Focuses the message input of a chat modal.
	 *
	 * @param {JQuery} chatModal Chat room modal
	 */
	Chat.focusInput = function (chatModal) {
		setTimeout(function () {
			chatModal.find('[component="chat/input"]').focus();
		}, 20);
	};

	/**
	 * Closes a chat modal and cleans up the resources bound to it.
	 *
	 * @param {string} uuid Unique id of the modal to close
	 */
	Chat.close = function (uuid) {
		const chatModal = getModalByUuid(uuid);
		chatModal.find('[data-bs-toggle="tooltip"]').tooltip('dispose');
		chatModal.remove();
		chatModal.data('modal', null);
		taskbar.discard('chat', uuid);

		if (chatModal.attr('data-mobile')) {
			Chat.disableMobileBehaviour(chatModal);
		}

		require(['forum/chats'], function (chats) {
			chats.destroyAutoComplete(chatModal.find('[component="chat/input"]'));
		});

		Chat.leaveSocketRoom(chatModal.attr('data-roomid'));
		hooks.fire('action:chat.closed', {
			uuid: uuid,
			modal: chatModal,
		});
	};

	/**
	 * Leaves the socket room unless the user is still viewing it, either on the
	 * full chat page or through an open modal.
	 *
	 * @param {number|string} roomId Chat room to leave
	 */
	Chat.leaveSocketRoom = function (roomId) {
		if (!roomId) return;
		const isLookingAtRoom = Chat.isLookingAtRoom(roomId);
		const isModalOpen = Chat.modalExists(roomId);
		if (isLookingAtRoom !== isModalOpen) {
			socket.emit('modules.chats.leave', roomId);
		}
	};

	/**
	 * Positions a chat modal at the bottom right (or left, in RTL locales) of the
	 * viewport, temporarily un-hiding it when needed to measure its size.
	 *
	 * @param {JQuery} chatModal Chat room modal
	 * @returns {JQuery} The positioned modal
	 */
	Chat.position = function (chatModal) {
		let hideAfter = false;
		if (chatModal.hasClass('hide')) {
			chatModal.removeClass('hide');
			hideAfter = true;
		}
		const $window = $(window);
		const $chatContent = chatModal.find('.modal-content');
		const width = $chatContent.outerWidth(true);
		const height = $chatContent.outerHeight(true);
		const isRtl = $('html').attr('data-dir') === 'rtl';

		chatModal.css(isRtl ? 'right' : 'left', Math.max(0, ($window.width() - width)) + 'px');
		chatModal.css('top', Math.max(0, ($window.height() - height)) + 'px');

		if (hideAfter) {
			chatModal.addClass('hide');
		}
		return chatModal;
	};

	/**
	 * Loads a minimized or hidden chat modal back into view.
	 *
	 * @param {string} uuid Unique id of the modal to load
	 */
	Chat.load = function (uuid) {
		require(['forum/chats/messages'], function (ChatsMessages) {
			const chatModal = getModalByUuid(uuid);
			chatModal.removeClass('hide');
			bringModalToFront(chatModal);
			taskbar.updateActive(uuid);
			ChatsMessages.scrollToBottomAfterImageLoad(chatModal.find('.chat-content'));
			Chat.focusInput(chatModal);
			const roomId = chatModal.attr('data-roomid');
			api.del(`/chats/${roomId}/state`, {});
			socket.emit('modules.chats.enter', roomId);
			const env = utils.findBootstrapEnvironment();
			if (env === 'xs' || env === 'sm') {
				Chat.enableMobileBehaviour(chatModal);
			}
		});
	};

	/**
	 * Switches a chat modal to its full-screen mobile layout.
	 *
	 * @param {JQuery} modalEl Chat room modal
	 */
	Chat.enableMobileBehaviour = function (modalEl) {
		app.toggleNavbar(false);
		modalEl.attr('data-mobile', '1');
		const messagesEl = modalEl.find('.modal-body');
		messagesEl.css('height', Chat.calculateChatListHeight(modalEl));

		function resize() {
			messagesEl.css('height', Chat.calculateChatListHeight(modalEl));
			require(['forum/chats/messages'], function (ChatsMessages) {
				ChatsMessages.scrollToBottom(modalEl.find('.chat-content'));
			});
		}

		$(window).on('resize', resize);
		$(window).one('action:ajaxify.start', function () {
			Chat.close(modalEl.attr('data-uuid'));
			$(window).off('resize', resize);
		});
	};

	/**
	 * Restores the regular navbar after a mobile chat modal is closed.
	 */
	Chat.disableMobileBehaviour = function () {
		app.toggleNavbar(true);
	};

	/**
	 * Calculates the height available to the chat message list of a modal.
	 *
	 * @param {JQuery} modalEl Chat room modal
	 * @returns {number} Modal height minus the height of its header
	 */
	Chat.calculateChatListHeight = function (modalEl) {
		// Formula: modal height minus header height. Simple(tm).
		return modalEl.find('.modal-content').outerHeight() - modalEl.find('.modal-header').outerHeight();
	};

	/**
	 * Minimizes a chat modal into the taskbar.
	 *
	 * @param {string} uuid Unique id of the modal to minimize
	 */
	Chat.minimize = function (uuid) {
		const chatModal = getModalByUuid(uuid);
		chatModal.find('[data-bs-toggle="tooltip"]').tooltip('hide');
		chatModal.addClass('hide');
		taskbar.minimize('chat', uuid);
		hooks.fire('action:chat.minimized', {
			uuid: uuid,
			modal: chatModal,
		});
	};

	Chat.toggleNew = taskbar.toggleNew;

	return Chat;
});
