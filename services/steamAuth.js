// services/steamAuth.js — ИСПРАВЛЕННАЯ ВЕРСИЯ
import dotenv from 'dotenv';

dotenv.config();

export class SteamAuth {
  constructor() {
    this.apiKey = process.env.STEAM_API_KEY || 'FA913330BF05D43E04C2D32A4996A662';
    
    // ✅ ПРАВИЛЬНЫЕ URL-ы для Railway
    this.backendUrl = process.env.BACKEND_URL || 'https://backanedservaksale-production.up.railway.app';
    this.frontendUrl = process.env.FRONTEND_URL || 'https://skinssale.kz';
    
    console.log('[SteamAuth] 🔑 API Key:', this.apiKey ? `${this.apiKey.substring(0, 8)}...` : 'НЕ ЗАДАН');
    console.log('[SteamAuth] 🔧 Backend URL:', this.backendUrl);
    console.log('[SteamAuth] 🌐 Frontend URL:', this.frontendUrl);
  }

  getRedirectUrl() {
    // ✅ Callback должен идти на Railway backend
    const returnTo = `${this.backendUrl}/api/auth/steam/callback`;
    const realm = this.backendUrl;

    const params = new URLSearchParams({
      'openid.ns': 'http://specs.openid.net/auth/2.0',
      'openid.mode': 'checkid_setup',
      'openid.return_to': returnTo,
      'openid.realm': realm,
      'openid.identity': 'http://specs.openid.net/auth/2.0/identifier_select',
      'openid.claimed_id': 'http://specs.openid.net/auth/2.0/identifier_select'
    });

    const steamUrl = `https://steamcommunity.com/openid/login?${params.toString()}`;
    console.log(`[SteamAuth] 🎮 Редирект на Steam`);
    console.log(`[SteamAuth] 🔗 Return to: ${returnTo}`);
    
    return steamUrl;
  }

  extractSteamId(str) {
    if (!str) return null;
    const match = str.match(/7656119\d{10}/);
    return match ? match[0] : null;
  }

  isValidSteamId(id) {
    return /^7656119\d{10}$/.test(String(id));
  }

  async verifyAssertion(queryParams) {
    console.log('[SteamAuth] 📥 Проверка callback параметров...');
    this.debugParams(queryParams);

    if (queryParams['openid.mode'] !== 'id_res') {
      console.warn('[SteamAuth] ❌ openid.mode ≠ id_res');
      return null;
    }

    const claimedId = queryParams['openid.claimed_id'] || queryParams['openid.identity'];
    const steamId = this.extractSteamId(claimedId);

    if (!steamId || !this.isValidSteamId(steamId)) {
      console.error('[SteamAuth] ❌ Невалидный Steam ID:', claimedId);
      return null;
    }

    // Валидация через Steam API
    if (process.env.NODE_ENV === 'production' && this.apiKey) {
      console.log('[SteamAuth] 🔐 Проверка через Steam API...');
      const isValid = await this.performSteamValidation(queryParams);
      if (!isValid) {
        console.error('[SteamAuth] ❌ Steam validation failed');
        return null;
      }
    } else {
      console.log('[SteamAuth] 🟡 Пропускаем валидацию (dev mode или API key отсутствует)');
    }

    console.log(`[SteamAuth] ✅ Успешная аутентификация: ${steamId}`);
    return steamId;
  }

  async verifyAssertionSimple(queryParams) {
    console.log('[SteamAuth] 🔄 Простая валидация...');
    try {
      const claimedId = queryParams['openid.claimed_id'] || queryParams['openid.identity'];
      const steamId = this.extractSteamId(claimedId);
      if (steamId && this.isValidSteamId(steamId)) {
        console.log(`[SteamAuth] ✅ Простая валидация успешна: ${steamId}`);
        return steamId;
      }
      return null;
    } catch (error) {
      console.error('[SteamAuth] ❌ Ошибка простой валидации:', error);
      return null;
    }
  }

  async performSteamValidation(queryParams) {
    try {
      const validationParams = new URLSearchParams();
      validationParams.append('openid.mode', 'check_authentication');

      for (const [key, value] of Object.entries(queryParams)) {
        if (key.startsWith('openid.')) {
          validationParams.append(key, value);
        }
      }

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);

      const response = await fetch('https://steamcommunity.com/openid/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'SkinSale/1.0'
        },
        body: validationParams.toString(),
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const text = await response.text();
      const isValid = text.includes('is_valid:true');
      
      console.log(`[SteamAuth] ✅ Steam validation: ${isValid}`);
      return isValid;

    } catch (error) {
      console.error('[SteamAuth] 🛑 Steam validation error:', error.message);
      return process.env.NODE_ENV !== 'production';
    }
  }

  async getSteamProfile(steamId) {
    if (!this.apiKey) {
      console.warn('[SteamAuth] ⚠️ STEAM_API_KEY не задан → mock');
      return this.getMockProfile(steamId);
    }

    try {
      const url = `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key=${this.apiKey}&steamids=${steamId}`;
      
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000);

      const res = await fetch(url, {
        headers: { 'User-Agent': 'SkinSale-App/1.0' },
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (!res.ok) throw new Error(`Steam API ${res.status}`);
      
      const data = await res.json();
      const player = data.response?.players?.[0];
      if (!player) throw new Error('Player not found');

      return {
        steamid: player.steamid,
        personaname: player.personaname || 'Steam User',
        avatar: player.avatarfull || player.avatarmedium || player.avatar || '',
        profileurl: player.profileurl || `https://steamcommunity.com/profiles/${steamId}`,
        timecreated: player.timecreated,
        loccountrycode: player.loccountrycode
      };
    } catch (error) {
      console.error('[SteamAuth] ❌ Ошибка профиля:', error.message);
      return this.getMockProfile(steamId);
    }
  }

  getMockProfile(steamId) {
    return {
      steamid: steamId,
      personaname: `User_${steamId.slice(-6)}`,
      avatar: 'https://avatars.steamstatic.com/fef49e7fa7e1997310d705b2a6158ff8dc1cdfeb.jpg',
      profileurl: `https://steamcommunity.com/profiles/${steamId}`,
      timecreated: Math.floor(Date.now() / 1000) - 365 * 24 * 60 * 60
    };
  }

  debugParams(qp) {
    console.log('=== 🔍 STEAM CALLBACK PARAMS ===');
    const keys = Object.keys(qp);
    if (keys.length === 0) {
      console.log('пусто (req.query пуст!)');
    } else {
      keys.forEach(k => {
        if (k.startsWith('openid.')) {
          console.log(`${k}: ${qp[k]?.substring(0, 100)}${qp[k]?.length > 100 ? '...' : ''}`);
        }
      });
    }
    console.log('=== 🔚 END ===');
  }

  async checkSteamApiHealth() {
    if (!this.apiKey) {
      return { healthy: false, reason: 'STEAM_API_KEY missing' };
    }
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);
      const res = await fetch('https://api.steampowered.com/ISteamWebAPIUtil/GetServerInfo/v1/', {
        signal: controller.signal
      });
      clearTimeout(timeoutId);
      return { healthy: res.ok, reason: res.ok ? 'OK' : `HTTP ${res.status}` };
    } catch (e) {
      return { healthy: false, reason: e.message };
    }
  }
}

export const steamAuth = new SteamAuth();
