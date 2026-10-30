(() => {
    let pendingSilentEditMessageId = null;
    let cachedRest = null;

    function Settings({ api }) {
        const { modules, discord, assets } = api.unscoped;
        const { lookupModule, filters } = modules.finders;
        const [React] = lookupModule(filters.withProps('createElement', 'useEffect'));
        const [ReactNative] = lookupModule(filters.withProps('AppRegistry'));
        const { Design } = discord.design;
        const { ScrollView } = ReactNative;
        const { TableRowGroup, TableSwitchRow, TableRow, Stack } = Design;
        const h = React.createElement;
        const storage = api.jsonStorage;
        const state = storage.use() ?? {};
        const iconId = assets.getAssetIdByName('PencilIcon');
        return h(ScrollView, { style: { flex: 1 }, contentContainerStyle: { paddingBottom: 38 } }, h(Stack, { style: { paddingVertical: 24, paddingHorizontal: 12 }, spacing: 24 }, h(TableRowGroup, { title: 'Settings' }, h(TableSwitchRow, {
            label: 'Inject Original Edit',
            subLabel: 'Replace original edit with silent edit.',
            icon: iconId !== undefined ? h(TableRow.Icon, { source: iconId }) : null,
            value: state.overrideNative ?? true,
            onValueChange: (v) => storage.set({ overrideNative: v }),
        }))));
    }

    function isSendRequestTypeError(err) {
        const message = String(err?.message || err || '');
        return message.includes('sendRequest') && message.includes('string');
    }

    // Discord's real client helper is HTTPUtils.HTTP (discord_common/.../HTTPUtils.tsx).
    // Its methods take `{ url, body, query }`. A looser lookup for get/post/del/patch
    // hits another module that forwards the first argument straight into native
    // sendRequest, which requires a string URL — that is the HostFunction error.
    function resolveRest(finders) {
        if (cachedRest) return cachedRest;
        const { lookupModule, lookupModules, filters } = finders;
        const { withProps } = filters;

        const consider = (candidate) => {
            if (!candidate) return false;
            const post = candidate.post;
            const get = candidate.get;
            const del = candidate.del || candidate.delete;
            if (typeof post !== 'function' || typeof get !== 'function' || typeof del !== 'function') {
                return false;
            }
            cachedRest = candidate;
            return true;
        };

        if (typeof lookupModules === 'function') {
            for (const [mod] of lookupModules(withProps('HTTP', 'post'))) {
                if (consider(mod?.HTTP)) break;
            }
            if (!cachedRest) {
                for (const [mod] of lookupModules(withProps('getAPIBaseURL', 'post', 'get'))) {
                    if (consider(mod)) break;
                }
            }
        }

        if (!cachedRest) {
            const [HTTPUtils] = lookupModule(withProps('HTTP', 'post'));
            consider(HTTPUtils?.HTTP);
        }
        if (!cachedRest) {
            const [legacy] = lookupModule(withProps('get', 'post', 'del', 'patch'));
            consider(legacy);
        }
        return cachedRest;
    }

    async function restCall(api, method, url, extra) {
        const fn = api[method] || (method === 'del' ? api.delete : undefined);
        if (typeof fn !== 'function') {
            throw new Error('Discord HTTP.' + method + ' was not found');
        }
        const options = extra ? { url, ...extra } : { url };
        try {
            return await fn.call(api, options);
        }
        catch (err) {
            // Last resort: some builds want (url, options) and pass the URL string to sendRequest.
            if (!isSendRequestTypeError(err)) throw err;
            return await fn.call(api, url, extra || {});
        }
    }

    function unwrapBody(response) {
        if (Array.isArray(response)) return response;
        if (Array.isArray(response?.body)) return response.body;
        return null;
    }

    const __plugin = plugin({
        jsonStorage: { load: true, default: { overrideNative: true } },
        SettingsComponent: Settings,
        start(api) {
            const { cleanup, unscoped, jsonStorage } = api;
            const { modules: { finders, finders: { getModules, lookupModule, filters }, }, patcher: { instead, before, after }, utils: { tree }, } = unscoped;
            const { withProps } = filters;
            const isOverride = () => jsonStorage.cache?.overrideNative ?? true;
            const toast = (text) => {
                try {
                    unscoped.discord.actions.ToastActionCreators.open('silent-edit', { text });
                }
                catch {
                    console.log('[SilentEdit]', text);
                }
            };
            const [React] = lookupModule(withProps('createElement', 'useEffect'));
            const walkable = new Set(['props', 'children']);
            const findInReactTree = (node, filter) => tree.findInTree(node, filter, { walkable });

            cleanup(getModules(withProps('editMessage'), (MessageActions) => {
                cleanup(instead(MessageActions, 'editMessage', async (args, orig) => {
                    const [channelId, messageId, reqData] = args;
                    if (!isOverride() && pendingSilentEditMessageId !== messageId) {
                        return orig(...args);
                    }
                    pendingSilentEditMessageId = null;
                    try {
                        const RestAPI = resolveRest(finders);
                        if (!RestAPI) return orig(...args);

                        let msg = null;
                        try {
                            const [MessageStore] = lookupModule(withProps('getMessage', 'getMessages'));
                            msg = MessageStore?.getMessage?.(channelId, messageId) || null;
                        }
                        catch {
                            msg = null;
                        }
                        if (!msg) {
                            const originalMessage = await restCall(RestAPI, 'get', `/channels/${channelId}/messages`, {
                                query: { limit: 1, around: messageId },
                            });
                            const msgArray = unwrapBody(originalMessage);
                            if (!msgArray?.length) return orig(...args);
                            msg = msgArray.find((m) => m.id === messageId);
                        }
                        if (!msg) return orig(...args);

                        let content = reqData.content;
                        const regex = /\.filename\s+(\S+)/g;
                        let matches = [...content.matchAll(regex)];
                        let attachments;
                        if (matches.length > 0) {
                            matches = matches.slice(0, 10);
                            attachments = matches.map((match, index) => {
                                const uploadedFilename = match[1];
                                const filename = uploadedFilename.split('/').pop() || 'image.png';
                                return {
                                    id: String(index),
                                    filename,
                                    uploaded_filename: uploadedFilename,
                                };
                            });
                            content = content.replace(/\.filename\s+(\S+)/g, '').trim();
                        }
                        const body = {
                            content,
                            nonce: messageId,
                            tts: false,
                            flags: msg.flags ?? 0,
                            mobile_network_type: 'wifi',
                        };
                        if (attachments) body.attachments = attachments;
                        if (msg.message_reference) {
                            body.message_reference = {
                                message_id: msg.message_reference.message_id,
                                channel_id: msg.message_reference.channel_id,
                                guild_id: msg.message_reference.guild_id,
                            };
                            const repliedUser = msg.referenced_message?.author?.id;
                            const hasPing = repliedUser
                                ? msg.mentions?.some((m) => m.id === repliedUser)
                                : false;
                            body.allowed_mentions = {
                                replied_user: hasPing,
                                parse: ['users', 'roles', 'everyone'],
                            };
                        }
                        const response = await restCall(RestAPI, 'post', `/channels/${channelId}/messages`, { body });
                        await restCall(RestAPI, 'del', `/channels/${channelId}/messages/${messageId}`);
                        return response;
                    }
                    catch (err) {
                        toast('Error: ' + (err?.body?.message || err?.message || String(err)));
                        return orig(...args);
                    }
                }));
            }));

            const { ActionSheetActionCreators } = unscoped.discord.actions;
            cleanup(before(ActionSheetActionCreators, 'openLazy', (args) => {
                try {
                    const [component, key, msg] = args;
                    if (isOverride()) return args;
                    const message = msg?.message;
                    if (key !== 'MessageLongPressActionSheet' || !message) return args;
                    pendingSilentEditMessageId = null;
                    const [UserStore] = lookupModule(withProps('getCurrentUser'));
                    const currentUser = UserStore?.getCurrentUser();
                    if (!currentUser || message.author?.id !== currentUser.id) return args;
                    const { ActionSheetRow, TableRowGroup } = unscoped.discord.design.Design;
                    const iconId = unscoped.assets.getAssetIdByName('PencilIcon');
                    component.then((instance) => {
                        const unpatch = after(instance, 'default', (comp) => {
                            try {
                                React.useEffect(() => () => unpatch(), []);
                                const groups = findInReactTree(comp, (c) => Array.isArray(c) &&
                                    (c[0]?.type === TableRowGroup ||
                                        c[0]?.type?.name === 'ActionSheetRowGroup'));
                                if (!groups?.length) return comp;
                                let editRowOnPress = null;
                                let targetGroupChildren = null;
                                let targetIndex = -1;
                                for (const group of groups) {
                                    const groupChildren = findInReactTree(group, (c) => Array.isArray(c) &&
                                        c.some((child) => child?.type === ActionSheetRow ||
                                            child?.type?.name === 'ActionSheetRow'));
                                    if (!groupChildren) continue;
                                    const idx = groupChildren.findIndex((c) => {
                                        const label = String(c?.props?.label || c?.props?.message || '').toLowerCase();
                                        return label.includes('edit');
                                    });
                                    if (idx >= 0) {
                                        editRowOnPress = groupChildren[idx].props.onPress;
                                        targetGroupChildren = groupChildren;
                                        targetIndex = idx;
                                        break;
                                    }
                                }
                                if (!editRowOnPress || !targetGroupChildren) return comp;
                                const silentEditBtn = React.createElement(ActionSheetRow, {
                                    label: 'Silent Edit',
                                    icon: iconId !== undefined
                                        ? React.createElement(ActionSheetRow.Icon, { source: iconId })
                                        : undefined,
                                    onPress: () => {
                                        pendingSilentEditMessageId = message.id;
                                        editRowOnPress();
                                    },
                                });
                                targetGroupChildren.splice(targetIndex + 1, 0, silentEditBtn);
                            }
                            catch (e) {
                                console.log('[SilentEdit] sheet patch failed', e);
                            }
                            return comp;
                        });
                    });
                }
                catch (e) {
                    console.log('[SilentEdit] openLazy hook failed', e);
                }
                return args;
            }));
        },
    });
    return { default: __plugin };
})()
