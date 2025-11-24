// backend/services/steamAuth.js
import fetch from 'node-fetch';
import { v4 as uuidv4 } from 'uuid';

class SteamAuth {
  constructor() {
    this.realm = process.env.STEAM_REALM || 'http://localhost:3000';
    this.returnUrl = `${this.realm}/auth/steam/callback`;
    this.apiKey = process.env.STEAM_API_KEY;
  }

  // Генерация URL для аутентификации через Steam
  getRedirectUrl() {
    const nonce = uuidv4();
    const params = new URLSearchParams({
      'openid.ns': 'http://specs.openid.net/auth/2.0',
      'openid.mode': 'checkid_setup',
      'openid.return_to': this.returnUrl,
      'openid.realm': this.realm,
      'openid.identity': 'http://specs.openid.net/auth/2.0/identifier_select',
      'openid.claimed_id': 'http://specs.openid.net/auth/2.0/identifier_select'
    });

    return `https://steamcommunity.com/openid/login?${params.toString()}`;
  }

  // Верификация ответа от Steam
  async verifyAssertion(assertionUrl) {
    try {
      const response = await fetch(assertionUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      });

      const text = await response.text();
      
      if (response.ok && text.includes('is_valid:true')) {
        // Извлекаем Steam ID из ответа
        const steamIdMatch = text.match(/https:\/\/steamcommunity\.com\/openid\/id\/(\d+)/);
        if (steamIdMatch && steamIdMatch[1]) {
          return steamIdMatch[1];
        }
      }
      
      return null;
    } catch (error) {
      console.error('Steam auth verification error:', error);
      return null;
    }
  }

  // Получение профиля пользователя по Steam ID
  async getSteamProfile(steamId) {
    try {
      const response = await fetch(
        `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key=${this.apiKey}&steamids=${steamId}`
      );
      
      const data = await response.json();
      
      if (data.response && data.response.players && data.response.players.length > 0) {
        const player = data.response.players[0];
        return {
          steamid: player.steamid,
          personaname: player.personaname,
          avatar: player.avatarfull,
          profileurl: player.profileurl,
          timecreated: player.timecreated,
          loccountrycode: player.loccountrycode
        };
      }
      
      return null;
    } catch (error) {
      console.error('Steam profile fetch error:', error);
      return null;
    }
  }
}

export const steamAuth = new SteamAuth();
