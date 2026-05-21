import { withElectronProtocolIfElectron } from '@/const/protocol';

export const API_ENDPOINTS = {
  oauth: withElectronProtocolIfElectron('/chat/api/auth'),

  proxy: withElectronProtocolIfElectron('/chat/webapi/proxy'),

  // trace
  trace: withElectronProtocolIfElectron('/chat/webapi/trace'),

  // chat
  chat: (provider: string) => withElectronProtocolIfElectron(`/chat/webapi/chat/${provider}`),

  // models
  models: (provider: string) => withElectronProtocolIfElectron(`/chat/webapi/models/${provider}`),
  modelPull: (provider: string) =>
    withElectronProtocolIfElectron(`/chat/webapi/models/${provider}/pull`),

  // STT
  stt: withElectronProtocolIfElectron('/chat/webapi/stt/openai'),

  // TTS
  tts: (provider: string) => withElectronProtocolIfElectron(`/chat/webapi/tts/${provider}`),
  edge: withElectronProtocolIfElectron('/chat/webapi/tts/edge'),
  microsoft: withElectronProtocolIfElectron('/chat/webapi/tts/microsoft'),
};

export const MARKET_OIDC_ENDPOINTS = {
  // NOTE: `auth` is used to open a page in the system browser (desktop) / popup (web),
  // so it must always be an HTTP(S) path joined with `NEXT_PUBLIC_MARKET_BASE_URL`.
  // It MUST NOT be wrapped by the Electron backend protocol.
  auth: '/chat/lobehub-oidc/auth',
  token: withElectronProtocolIfElectron('/chat/market/oidc/token'),
  userinfo: withElectronProtocolIfElectron('/chat/market/oidc/userinfo'),
  handoff: withElectronProtocolIfElectron('/chat/market/oidc/handoff'),
  // Same as `auth`: used as `redirect_uri` (must be a real web URL under market base).
  desktopCallback: '/chat/lobehub-oidc/callback/desktop',
};

export const MARKET_ENDPOINTS = {
  base: withElectronProtocolIfElectron('/chat/market'),
  // Agent management
  createAgent: withElectronProtocolIfElectron('/chat/market/agent/create'),
  getAgentDetail: (identifier: string) =>
    withElectronProtocolIfElectron(`/chat/market/agent/${encodeURIComponent(identifier)}`),
  getOwnAgents: withElectronProtocolIfElectron('/chat/market/agent/own'),
  createAgentVersion: withElectronProtocolIfElectron('/chat/market/agent/versions/create'),
  // Agent status management
  publishAgent: (identifier: string) =>
    withElectronProtocolIfElectron(`/chat/market/agent/${encodeURIComponent(identifier)}/publish`),
  unpublishAgent: (identifier: string) =>
    withElectronProtocolIfElectron(
      `/chat/market/agent/${encodeURIComponent(identifier)}/unpublish`,
    ),
  deprecateAgent: (identifier: string) =>
    withElectronProtocolIfElectron(
      `/chat/market/agent/${encodeURIComponent(identifier)}/deprecate`,
    ),
  // User profile
  getUserProfile: (username: string) =>
    withElectronProtocolIfElectron(`/chat/market/user/${encodeURIComponent(username)}`),
  updateUserProfile: withElectronProtocolIfElectron('/chat/market/user/me'),

  // Social - Follow
  follow: withElectronProtocolIfElectron('/chat/market/social/follow'),
  unfollow: withElectronProtocolIfElectron('/chat/market/social/unfollow'),
  followStatus: (userId: number) =>
    withElectronProtocolIfElectron(`/chat/market/social/follow-status/${userId}`),
  following: (userId: number) =>
    withElectronProtocolIfElectron(`/chat/market/social/following/${userId}`),
  followers: (userId: number) =>
    withElectronProtocolIfElectron(`/chat/market/social/followers/${userId}`),
  followCounts: (userId: number) =>
    withElectronProtocolIfElectron(`/chat/market/social/follow-counts/${userId}`),

  // Social - Favorite
  favorite: withElectronProtocolIfElectron('/chat/market/social/favorite'),
  unfavorite: withElectronProtocolIfElectron('/chat/market/social/unfavorite'),
  favoriteStatus: (targetType: 'agent' | 'plugin', targetIdOrIdentifier: number | string) =>
    withElectronProtocolIfElectron(
      `/chat/market/social/favorite-status/${targetType}/${encodeURIComponent(targetIdOrIdentifier)}`,
    ),
  myFavorites: withElectronProtocolIfElectron('/chat/market/social/favorites'),
  userFavorites: (userId: number) =>
    withElectronProtocolIfElectron(`/chat/market/social/user-favorites/${userId}`),
  favoriteAgents: (userId: number) =>
    withElectronProtocolIfElectron(`/chat/market/social/favorite-agents/${userId}`),
  favoritePlugins: (userId: number) =>
    withElectronProtocolIfElectron(`/chat/market/social/favorite-plugins/${userId}`),

  // Social - Like
  like: withElectronProtocolIfElectron('/chat/market/social/like'),
  unlike: withElectronProtocolIfElectron('/chat/market/social/unlike'),
  toggleLike: withElectronProtocolIfElectron('/chat/market/social/toggle-like'),
  likeStatus: (targetType: 'agent' | 'plugin', targetIdOrIdentifier: number | string) =>
    withElectronProtocolIfElectron(
      `/chat/market/social/like-status/${targetType}/${encodeURIComponent(targetIdOrIdentifier)}`,
    ),
  likedAgents: (userId: number) =>
    withElectronProtocolIfElectron(`/chat/market/social/liked-agents/${userId}`),
  likedPlugins: (userId: number) =>
    withElectronProtocolIfElectron(`/chat/market/social/liked-plugins/${userId}`),
};
