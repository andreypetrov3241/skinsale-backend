// services/steamService.js
import SteamAPI from 'steamapi';
const steam = new SteamAPI(process.env.STEAM_API_KEY);

export class SteamService {
  // Получение инвентаря пользователя
  async getUserInventory(steamId, appId = 730) {
    try {
      console.log(`Получение инвентаря для ${steamId}, игра: ${appId}`);
      
      const inventory = await steam.getUserInventory(steamId, appId);
      
      // Фильтруем только торговые предметы
      const tradableItems = inventory.filter(item => 
        item.tradable && 
        !item.market_hash_name.includes('StatTrak™') // Пример фильтра
      );
      
      console.log(`Найдено ${tradableItems.length} торговых предметов`);
      
      return tradableItems.map(item => ({
        steam_id: item.id || item.assetid,
        market_hash_name: item.market_hash_name,
        name: item.name,
        image_url: item.icon_url || item.icon_url_large,
        game: appId === 730 ? 'CS2' : 'Dota2',
        rarity: this.getRarity(item),
        quality: this.getQuality(item),
        tradable: item.tradable,
        price: await this.calculatePrice(item.market_hash_name),
        exterior: item.exterior || 'Unknown'
      }));
      
    } catch (error) {
      console.error('Steam inventory error:', error);
      throw new Error('Не удалось получить инвентарь. Проверьте настройки приватности Steam.');
    }
  }

  // Создание трейд оффера
  async createTradeOffer(userSteamId, botSteamId, itemsToSend, itemsToReceive) {
    try {
      // Здесь будет реальная логика создания трейда
      // Пока возвращаем mock для тестирования
      return {
        tradeOfferId: `trade_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        status: 'pending',
        message: 'Трейд оффер создан успешно'
      };
    } catch (error) {
      console.error('Trade creation error:', error);
      throw new Error('Ошибка создания трейда');
    }
  }

  // Вспомогательные методы
  getRarity(item) {
    const colors = {
      'common': 'Common',
      'uncommon': 'Uncommon', 
      'rare': 'Rare',
      'mythical': 'Mythical',
      'legendary': 'Legendary',
      'ancient': 'Ancient',
      'immortal': 'Immortal'
    };
    
    return colors[item.rarity] || 'Common';
  }

  getQuality(item) {
    return item.exterior || 'Field-Tested';
  }

  async calculatePrice(marketHashName) {
    // Здесь можно интегрировать с Steam Market API
    // Пока возвращаем mock цены
    const basePrice = Math.random() * 1000 + 100;
    return Math.round(basePrice);
  }
}

export const steamService = new SteamService();
