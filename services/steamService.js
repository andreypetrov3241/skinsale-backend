// backend/services/steamService.js — ОПТИМИЗИРОВАННАЯ ВЕРСИЯ ДЛЯ ВЫСОКОЙ НАГРУЗКИ
import dotenv from 'dotenv';
import NodeCache from 'node-cache';

dotenv.config();

// ✅ УБРАН ПРОБЕЛ В STEAM_API_BASE
const STEAM_API_KEY = process.env.STEAM_API_KEY || 'FA913330BF05D43E04C2D32A4996A662';
const STEAM_API_BASE = 'https://api.steampowered.com';

export class SteamService {
  constructor() {
    this.enabled = STEAM_API_KEY && STEAM_API_KEY.length === 32;
    this.cache = new NodeCache({ stdTTL: 300, checkperiod: 60, maxKeys: 10000 }); // УВЕЛИЧЕН КЭШ
    
    if (!this.enabled) {
      console.warn('[STEAM] ⚠️ Steam API ключ не настроен — используем MOCK-режим');
    } else {
      console.log('[STEAM] ✅ Steam Web API активирован');
    }
  }

  async fetchSteam(endpoint, params = {}, retries = 2) {
    if (!this.enabled) return null;

    // ✅ КОРРЕКТНЫЙ URL — БЕЗ ПРОБЕЛОВ
    const url = new URL(`${STEAM_API_BASE}${endpoint}/v0001/`);
    url.searchParams.append('key', STEAM_API_KEY);
    Object.entries(params).forEach(([k, v]) => url.searchParams.append(k, v));

    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        console.log(`[STEAM] 📡 Запрос: ${endpoint}`);

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 8000); // 8 сек — достаточно для Steam

        const response = await fetch(url, {
          method: 'GET',
          signal: controller.signal,
          headers: { 'User-Agent': 'SkinSale-App/1.0' },
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        const data = await response.json();
        return data?.response || data;

      } catch (error) {
        console.error(`[STEAM] ❌ Ошибка запроса ${endpoint}:`, error.message);
        if (attempt < retries) {
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
      }
    }
    return null;
  }

  isValidSteamId(steamId) {
    return /^7656119\d{10}$/.test(String(steamId));
  }

  async getUserInventory(steamId, appId = 730) {
    const cacheKey = `inventory_${steamId}_${appId}`;
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;

    if (!this.isValidSteamId(steamId)) {
      console.error('[STEAM] ❌ Неверный Steam ID:', steamId);
      return this.getMockItems(appId);
    }

    try {
      if (appId === 730) {
        const inventoryData = await this.fetchSteam('/IEconItems_730/GetPlayerItems', {
          steamid: steamId,
        });

        if (!inventoryData || inventoryData?.Error) {
          console.warn('[STEAM] 📦 Пустой ответ или ошибка от Steam API');
          return this.getMockItems(appId);
        }

        const items = inventoryData.items || [];
        const validItems = items
          .filter(item => item.tradable === 1)
          .map(item => this.processItem(item))
          .filter(item => item !== null);

        this.cache.set(cacheKey, validItems);
        console.log(`[STEAM] ✅ Загружено ${validItems.length} предметов`);
        return validItems;
      }

      return this.getMockItems(appId);

    } catch (error) {
      console.error('[STEAM] 💥 Ошибка получения инвентаря:', error.message);
      return this.getMockItems(appId);
    }
  }

  processItem(item) {
    try {
      // ✅ УБРАН ПРОБЕЛ В URL изображения
      const imageUrl = item.icon_url 
        ? `https://community.akamai.steamstatic.com/economy/image/${item.icon_url}/62fx62f`
        : '';

      return {
        steam_id: String(item.id || item.assetid),
        market_hash_name: this.generateMarketHashName(item),
        name: this.getItemName(item),
        image_url: imageUrl,
        game: 'cs2',
        rarity: this.getRarity(item),
        quality: this.getQuality(item),
        exterior: this.getExterior(item),
        tradable: true,
        price: this.calculatePrice(item),
        float_value: item.floatvalue || null,
        paint_index: item.paintindex || null,
        sticker_count: item.stickers ? item.stickers.length : 0,
        def_index: item.defindex || item.def_index,
      };
    } catch (error) {
      console.error('[STEAM] ❌ Ошибка обработки предмета:', error);
      return null;
    }
  }

  generateMarketHashName(item) {
    const weapons = {
      7: 'AK-47',
      9: 'AWP', 
      16: 'M4A4',
      60: 'M4A1-S',
    };
    const weapon = weapons[item.defindex] || 'Weapon';
    const exterior = this.getExterior(item);
    return `${weapon} | ${this.getItemName(item)} (${exterior})`;
  }

  getItemName(item) {
    const names = {
      7: 'Redline',
      9: 'Asiimov',
      16: 'Desert-Strike',
      60: 'Hyper Beast'
    };
    return names[item.defindex] || 'Skin';
  }

  getRarity(item) {
    const rarities = {
      1: 'common', 2: 'uncommon', 3: 'rare',
      4: 'mythical', 5: 'legendary', 6: 'ancient'
    };
    return rarities[item.rarity] || 'common';
  }

  getQuality(item) {
    const exterior = this.getExterior(item).toLowerCase();
    const qualities = {
      'factory new': 'factory-new',
      'minimal wear': 'minimal-wear',
      'field-tested': 'field-tested',
      'well-worn': 'well-worn',
      'battle-scarred': 'battle-scarred',
    };
    return qualities[exterior] || 'field-tested';
  }

  getExterior(item) {
    const float = item.floatvalue;
    if (float < 0.07) return 'Factory New';
    if (float < 0.15) return 'Minimal Wear';
    if (float < 0.38) return 'Field-Tested';
    if (float < 0.45) return 'Well-Worn';
    return 'Battle-Scarred';
  }

  calculatePrice(item) {
    const basePrice = 100 + (item.rarity || 1) * 50;
    const variation = 0.8 + Math.random() * 0.4;
    return Math.round(basePrice * variation);
  }

  getMockItems(appId) {
    if (appId === 730) {
      return [
        {
          steam_id: '12345678901234567',
          market_hash_name: 'AK-47 | Redline (Field-Tested)',
          name: 'AK-47 | Redline',
          // ✅ УБРАНЫ ПРОБЕЛЫ В URL
          image_url: 'https://cdn2.csgo.com/item/image/width=458/StatTrak%E2%84%A2%20AK-47%20%7C%20Redline%20(Field-Tested).webp',
          game: 'cs2',
          rarity: 'mythical',
          quality: 'field-tested',
          exterior: 'Field-Tested',
          tradable: true,
          price: 1500,
          float_value: 0.12,
          paint_index: 123,
          sticker_count: 0,
          def_index: 7,
        },
        {
          steam_id: '98765432109876543',
          market_hash_name: 'AWP | Asiimov (Field-Tested)',
          name: 'AWP | Asiimov',
          // ✅ УБРАНЫ ПРОБЕЛЫ В URL
          image_url: 'https://cdn2.csgo.com/item/image/width=458/StatTrak%E2%84%A2%20AWP%20%7C%20Asiimov%20(Well-Worn).webp',
          game: 'cs2',
          rarity: 'legendary',
          quality: 'field-tested',
          exterior: 'Field-Tested',
          tradable: true,
          price: 3200,
          float_value: 0.25,
          paint_index: 456,
          sticker_count: 0,
          def_index: 9,
        }
      ];
    }
    return [];
  }

  async isApiHealthy() {
    if (!this.enabled) return false;
    
    try {
      const result = await this.fetchSteam('/ISteamWebAPIUtil/GetSupportedAPIList', {}, 1);
      return result !== null;
    } catch (error) {
      return false;
    }
  }

  async createTradeOffer(userSteamId, botSteamId, itemsToSend) {
    const tradeOfferId = `MOCK-${Date.now()}-${Math.random().toString(36).substring(2, 10)}`;
    
    console.log(`[STEAM] 🎭 Создан MOCK трейд-оффер: ${tradeOfferId}`);

    return {
      tradeOfferId,
      status: 'pending',
      message: 'Трейд-оффер создан в mock-режиме',
      itemsSent: itemsToSend,
      itemsReceived: [],
      expiresAt: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
      createdAt: new Date().toISOString(),
      userSteamId,
      botSteamId,
    };
  }
}

export const steamService = new SteamService();
