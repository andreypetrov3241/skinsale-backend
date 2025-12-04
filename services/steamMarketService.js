// backend/services/steamMarketService.js
import { steamMarketParser } from './steamMarketParser.js';
import { query } from '../db.js';

export class SteamMarketService {
  constructor() {
    this.parser = steamMarketParser;
    this.cacheDuration = 5 * 60 * 1000; // 5 минут кэша
    this.memoryCache = new Map();
    this.isUpdating = new Map();
    
    // Курсы валют
    this.currencyRates = {
      'KZT': 500,
      'USD': 1,
      'EUR': 0.85,
      'RUB': 90,
      'CNY': 7.2
    };
    
    console.log('[MarketService] ✅ Инициализирован с поддержкой валют');
  }

  // 🔄 ОСНОВНОЙ МЕТОД - ЗАГРУЗКА ИЗ БАЗЫ С КАТЕГОРИЗАЦИЕЙ
  async getMarketItems(game = 'cs2', limit = 500, currency = 'KZT', silent = false) {
    const cacheKey = `market_${game}_${currency}_${limit}`;
    
    // 1. Проверяем кэш в памяти
    const memoryCached = this.memoryCache.get(cacheKey);
    if (memoryCached && Date.now() - memoryCached.timestamp < this.cacheDuration) {
      !silent && console.log(`[MarketService] ⚡ Из памяти: ${memoryCached.items.length} предметов`);
      return memoryCached.items.slice(0, limit);
    }

    !silent && console.log(`[MarketService] 🚀 Загрузка из БД для ${game}, лимит: ${limit}`);
    
    try {
      // Загружаем ВСЕ предметы из базы
      const dbItems = await this.getItemsFromDatabase(game, 1000, currency);
      
      if (dbItems.length === 0) {
        console.log('[MarketService] 📭 В БД нет предметов, используем парсер');
        const parsedItems = await this.parser.getMarketItems(game === 'cs2' ? 730 : 570, limit, currency);
        const enrichedItems = this.enrichItems(parsedItems, currency);
        return enrichedItems.slice(0, limit);
      }

      !silent && console.log(`[MarketService] ✅ Загружено из БД: ${dbItems.length} предметов`);
      
      // Кэшируем результат
      this.memoryCache.set(cacheKey, { 
        items: dbItems, 
        timestamp: Date.now() 
      });

      return dbItems.slice(0, limit);

    } catch (error) {
      console.error('[MarketService] 💥 Ошибка загрузки:', error);
      // Fallback на парсер
      const fallbackItems = await this.parser.getFallbackItems(game === 'cs2' ? 730 : 570, currency);
      return this.enrichItems(fallbackItems, currency).slice(0, limit);
    }
  }

  // 📊 ЗАГРУЗКА ИЗ БАЗЫ ДАННЫХ С КАТЕГОРИЗАЦИЕЙ
  async getItemsFromDatabase(game = 'cs2', limit = 1000, currency = 'KZT') {
    try {
      const result = await query(
        `SELECT * FROM items 
         WHERE game = $1 
         ORDER BY created_at DESC 
         LIMIT $2`,
        [game, limit]
      );

      console.log(`[MarketService] 📊 Найдено в БД: ${result.rows.length} записей`);

      if (result.rows.length === 0) {
        return [];
      }

      // Обогащаем данные категориями и редкостями
      const enrichedItems = result.rows.map(item => 
        this.enrichDatabaseItem(item, currency, game)
      ).filter(item => item !== null);

      console.log(`[MarketService] 🎯 Обогащено: ${enrichedItems.length} предметов`);

      return enrichedItems;

    } catch (error) {
      console.error('[MarketService] ❌ Ошибка загрузки из БД:', error);
      return [];
    }
  }

  // 🏷️ ОБОГАЩЕНИЕ ДАННЫХ ИЗ БАЗЫ
  enrichDatabaseItem(dbItem, currency, game) {
    try {
      const itemData = dbItem.item_data || {};
      const name = dbItem.name || itemData.name || 'Unknown Item';
      
      // Определяем категорию и тип
      const categoryInfo = this.categorizeItem(name, game);
      
      // Определяем редкость
      const rarity = this.determineRarity(dbItem, itemData, name);
      
      // Конвертируем цену в выбранную валюту
      const priceInCurrency = this.convertPrice(dbItem.price || 0, 'USD', currency);
      
      // Формируем объект предмета
      const enrichedItem = {
        id: dbItem.id || `db_${Date.now()}_${Math.random()}`,
        name: name,
        price: priceInCurrency,
        original_price: dbItem.price || 0,
        image: dbItem.image_url || itemData.image_url || this.getFallbackImage(name),
        rarity: rarity,
        quality: dbItem.quality || itemData.quality || 'field-tested',
        exterior: dbItem.exterior || itemData.exterior || 'Field-Tested',
        game: dbItem.game || game,
        market_hash_name: dbItem.market_hash_name || name,
        
        // Категории для фильтрации
        category: categoryInfo.category,
        subcategory: categoryInfo.type,
        weapon_type: categoryInfo.type,
        
        // Статистика
        volume: Math.floor(Math.random() * 100),
        popular: this.isPopularItem(name, rarity),
        trending: Math.random() > 0.7,
        featured: Math.random() > 0.9,
        
        // Для отображения
        display_price: this.formatPrice(priceInCurrency, currency),
        tags: this.generateTagsForItem(name, rarity, categoryInfo.category),
        stats: this.generateStatsForItem(priceInCurrency),
        
        // Флаги доступности
        is_available: true,
        is_listed: true,
        discount: this.calculateDiscount(priceInCurrency)
      };

      return enrichedItem;

    } catch (error) {
      console.error('[MarketService] ❌ Ошибка обогащения предмета:', error);
      return null;
    }
  }

  // 💰 КОНВЕРТАЦИЯ ЦЕНЫ В ВАЛЮТУ
  convertPrice(price, fromCurrency, toCurrency) {
    if (fromCurrency === toCurrency) return price;
    
    const amountUSD = fromCurrency === 'USD' ? price : price / this.currencyRates[fromCurrency];
    return Math.round(amountUSD * this.currencyRates[toCurrency]);
  }

  // 🗂️ КАТЕГОРИЗАЦИЯ ПРЕДМЕТОВ
  categorizeItem(name, game) {
    const lowerName = name.toLowerCase();
    
    if (game === 'cs2') {
      // Ножи
      const knifeTypes = ['bayonet', 'kerambit', 'm9 bayonet', 'butterfly', 'huntsman', 'falchion', 'shadow daggers', 'bowie', 'gut', 'navaja', 'stiletto', 'talon', 'ursus', 'classic', 'paracord', 'survival', 'nomad', 'skeleton'];
      const knifeType = knifeTypes.find(type => lowerName.includes(type));
      if (knifeType) return { category: 'knives', type: knifeType };

      // Винтовки
      const rifleTypes = ['ak-47', 'm4a4', 'm4a1-s', 'aug', 'sg 553', 'galil ar', 'famas'];
      const rifleType = rifleTypes.find(type => lowerName.includes(type));
      if (rifleType) return { category: 'rifles', type: rifleType };

      // Снайперские
      const sniperTypes = ['awp', 'ssg 08', 'scar-20', 'g3sg1'];
      const sniperType = sniperTypes.find(type => lowerName.includes(type));
      if (sniperType) return { category: 'snipers', type: sniperType };

      // Пистолеты
      const pistolTypes = ['desert eagle', 'dual berettas', 'five-seven', 'glock-18', 'p250', 'cz75-auto', 'r8 revolver', 'tec-9', 'usp-s'];
      const pistolType = pistolTypes.find(type => lowerName.includes(type));
      if (pistolType) return { category: 'pistols', type: pistolType };

      // ПП
      const smgTypes = ['mac-10', 'mp5-sd', 'mp7', 'mp9', 'p90', 'pp-bizon', 'ump-45'];
      const smgType = smgTypes.find(type => lowerName.includes(type));
      if (smgType) return { category: 'smgs', type: smgType };

      // Дробовики
      const shotgunTypes = ['mag-7', 'nova', 'sawed-off', 'xm1014'];
      const shotgunType = shotgunTypes.find(type => lowerName.includes(type));
      if (shotgunType) return { category: 'shotguns', type: shotgunType };

      // Пулеметы
      const machinegunTypes = ['m249', 'negev'];
      const machinegunType = machinegunTypes.find(type => lowerName.includes(type));
      if (machinegunType) return { category: 'machineguns', type: machinegunType };

      // Перчатки
      if (lowerName.includes('glove') || lowerName.includes('hand wrap') || lowerName.includes('sport glove') || lowerName.includes('driver glove') || lowerName.includes('moto glove') || lowerName.includes('specialist glove')) {
        return { category: 'gloves', type: 'gloves' };
      }

      // Кейсы
      if (lowerName.includes('case') || lowerName.includes('capsule') || lowerName.includes('key')) {
        return { category: 'cases', type: 'case' };
      }

    } else if (game === 'dota2') {
      // Dota 2 категории
      if (lowerName.includes('arcana')) return { category: 'arcanas', type: 'arcana' };
      if (lowerName.includes('immortal')) return { category: 'immortals', type: 'immortal' };
      if (lowerName.includes('courier')) return { category: 'couriers', type: 'courier' };
      if (lowerName.includes('ward')) return { category: 'wards', type: 'ward' };
      if (lowerName.includes('set') || lowerName.includes('bundle')) return { category: 'sets', type: 'set' };
    }

    return { category: 'other', type: 'other' };
  }

  // ⭐ ОПРЕДЕЛЕНИЕ РЕДКОСТИ
  determineRarity(dbItem, itemData, name) {
    const lowerName = name.toLowerCase();
    
    // Сначала проверяем явные признаки в названии
    if (lowerName.includes('covert') || lowerName.includes('extraordinary') || lowerName.includes('arcana')) return 'Covert';
    if (lowerName.includes('classified') || lowerName.includes('ancient')) return 'Classified';
    if (lowerName.includes('restricted') || lowerName.includes('mythical')) return 'Restricted';
    if (lowerName.includes('mil-spec') || lowerName.includes('rare')) return 'Mil-Spec';
    if (lowerName.includes('industrial') || lowerName.includes('immortal')) return 'Industrial';
    if (lowerName.includes('consumer') || lowerName.includes('common')) return 'Consumer';
    
    // Если в названии нет, используем данные из БД
    if (dbItem.rarity) return dbItem.rarity;
    if (itemData.rarity) return itemData.rarity;
    
    // Fallback по цене
    const price = dbItem.price || itemData.price || 0;
    if (price > 50000) return 'Covert';
    if (price > 20000) return 'Classified';
    if (price > 10000) return 'Restricted';
    if (price > 5000) return 'Mil-Spec';
    if (price > 1000) return 'Industrial';
    
    return 'Consumer';
  }

  // 🔥 ОПРЕДЕЛЕНИЕ ПОПУЛЯРНЫХ ПРЕДМЕТОВ
  isPopularItem(name, rarity) {
    const popularWeapons = ['ak-47', 'awp', 'm4a4', 'm4a1-s', 'desert eagle', 'glock-18', 'usp-s'];
    const isPopularWeapon = popularWeapons.some(weapon => name.toLowerCase().includes(weapon));
    
    return isPopularWeapon || rarity === 'Covert' || rarity === 'Classified';
  }

  // 🏷️ ГЕНЕРАЦИЯ ТЕГОВ
  generateTagsForItem(name, rarity, category) {
    const tags = [];
    const lowerName = name.toLowerCase();
    
    // Теги по редкости
    if (rarity === 'Covert' || rarity === 'Arcana') tags.push('premium');
    if (rarity === 'Classified') tags.push('classified');
    
    // Теги по типу
    if (category === 'knives') tags.push('knife');
    if (category === 'gloves') tags.push('gloves');
    if (lowerName.includes('awp')) tags.push('awp');
    if (lowerName.includes('ak-47')) tags.push('ak47');
    if (lowerName.includes('m4')) tags.push('m4');
    if (lowerName.includes('case')) tags.push('case');
    if (lowerName.includes('sticker')) tags.push('sticker');
    
    // Теги по популярности
    if (this.isPopularItem(name, rarity)) tags.push('popular');
    
    return tags;
  }

  // 📊 ГЕНЕРАЦИЯ СТАТИСТИКИ
  generateStatsForItem(price) {
    return {
      popularity: Math.floor(Math.random() * 100),
      price_change_24h: (Math.random() - 0.5) * 20,
      volume_24h: Math.floor(Math.random() * 1000),
      avg_price_7d: Math.floor(price * (0.8 + Math.random() * 0.4))
    };
  }

  // 🖼️ ПОЛУЧЕНИЕ ИЗОБРАЖЕНИЯ
  getFallbackImage(name) {
    return 'https://community.akamai.steamstatic.com/economy/image/-9a81dlWLwJ2UUGcVs_nsVtzdOEdtWwKGZZLQHTxDZ7I56KU0Zwwo4NUX4oFJZEHLbXH5ApeO4YmlhxYQknCRvCo04DEVlxkKgpou-6kejhjxszFJTwW09S5moGYluX7P77YkWNF18l4jeHVu9TwjRqyrhVqZzvyLIHTLlRrYVrY-VA7wOnqgJW6vJqZzHRm7iJz-z-DyHx1/360fx360f';
  }

  // 💰 ФОРМАТИРОВАНИЕ ЦЕНЫ
  formatPrice(price, currency) {
    const symbols = {
      'KZT': '₸',
      'USD': '$',
      'EUR': '€',
      'RUB': '₽',
      'CNY': '¥'
    };

    const symbol = symbols[currency] || currency;
    const formattedPrice = Math.round(price).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
    
    return `${formattedPrice} ${symbol}`;
  }

  // 🎯 РАСЧЕТ СКИДКИ
  calculateDiscount(price) {
    if (Math.random() > 0.7) {
      return Math.floor(Math.random() * 30) + 5;
    }
    return 0;
  }

  // 🔄 ПРИНУДИТЕЛЬНОЕ ОБНОВЛЕНИЕ КЭША
  async forceRefreshCache(game = 'cs2', currency = 'KZT') {
    const cacheKey = `market_${game}_${currency}_500`;
    
    console.log(`[MarketService] 🔄 Принудительное обновление кэша для ${game}`);
    
    // Очищаем кэш
    this.memoryCache.delete(cacheKey);
    
    try {
      const items = await this.getItemsFromDatabase(game, 500, currency);
      this.memoryCache.set(cacheKey, { items, timestamp: Date.now() });
      
      console.log(`[MarketService] ✅ Кэш обновлен: ${items.length} предметов`);
      return { success: true, items_count: items.length };
    } catch (error) {
      console.error('[MarketService] ❌ Ошибка обновления:', error);
      return { success: false, error: error.message };
    }
  }

  // 🧹 ОЧИСТКА ВСЕГО КЭША
  clearAllCache() {
    const cacheSize = this.memoryCache.size;
    this.memoryCache.clear();
    console.log(`[MarketService] 🧹 Очищен весь кэш: ${cacheSize} записей`);
    return { cleared: cacheSize };
  }

  // 🧹 ОЧИСТКА СТАРОГО КЭША ИЗ БАЗЫ
  async clearOldCache() {
    try {
      const result = await query(
        'DELETE FROM market_cache WHERE created_at < NOW() - INTERVAL \'1 hour\''
      );
      console.log(`[MarketService] 🧹 Очищен старый кэш: ${result.rowCount} записей`);
    } catch (error) {
      console.error('[MarketService] ❌ Ошибка очистки кэша:', error);
    }
  }

  // 📈 ПОПУЛЯРНЫЕ ПРЕДМЕТЫ
  async getPopularItems(game = 'cs2', currency = 'KZT', limit = 20, silent = false) {
    const cacheKey = `popular_${game}_${currency}`;
    
    const memoryCached = this.memoryCache.get(cacheKey);
    if (memoryCached && Date.now() - memoryCached.timestamp < this.cacheDuration) {
      !silent && console.log(`[MarketService] ⚡ Популярные из памяти: ${memoryCached.items.length} предметов`);
      return memoryCached.items.slice(0, limit);
    }

    const allItems = await this.getMarketItems(game, 200, currency, silent);
    const popularItems = allItems
      .filter(item => item.popular)
      .sort((a, b) => (b.volume || 0) - (a.volume || 0))
      .slice(0, limit);

    this.memoryCache.set(cacheKey, { 
      items: popularItems, 
      timestamp: Date.now() 
    });

    return popularItems;
  }

  // 🔥 ТРЕНДОВЫЕ ПРЕДМЕТЫ
  async getTrendingItems(game = 'cs2', currency = 'KZT', limit = 15, silent = false) {
    const cacheKey = `trending_${game}_${currency}`;
    
    const memoryCached = this.memoryCache.get(cacheKey);
    if (memoryCached && Date.now() - memoryCached.timestamp < this.cacheDuration) {
      !silent && console.log(`[MarketService] ⚡ Тренды из памяти: ${memoryCached.items.length} предметов`);
      return memoryCached.items.slice(0, limit);
    }

    const allItems = await this.getMarketItems(game, 150, currency, silent);
    const trendingItems = allItems
      .filter(item => item.trending)
      .sort((a, b) => (b.stats?.popularity || 0) - (a.stats?.popularity || 0))
      .slice(0, limit);

    this.memoryCache.set(cacheKey, { 
      items: trendingItems, 
      timestamp: Date.now() 
    });

    return trendingItems;
  }

  // 🔍 ПОИСК ПРЕДМЕТОВ
  async searchItems(query, game = 'cs2', currency = 'KZT', limit = 50) {
    const cacheKey = `search_${game}_${currency}_${query.toLowerCase()}`;
    
    const memoryCached = this.memoryCache.get(cacheKey);
    if (memoryCached && Date.now() - memoryCached.timestamp < 2 * 60 * 1000) {
      console.log(`[MarketService] ⚡ Поиск из кэша: "${query}"`);
      return memoryCached.items.slice(0, limit);
    }

    console.log(`[MarketService] 🔍 Выполняем поиск: "${query}"`);
    
    const allItems = await this.getMarketItems(game, 300, currency, true);
    const searchTerm = query.toLowerCase();
    
    const filteredItems = allItems.filter(item => 
      item.name.toLowerCase().includes(searchTerm) ||
      (item.market_hash_name && item.market_hash_name.toLowerCase().includes(searchTerm)) ||
      (item.tags && item.tags.some(tag => tag.includes(searchTerm)))
    );

    const result = filteredItems.slice(0, limit);
    
    this.memoryCache.set(cacheKey, { 
      items: result, 
      timestamp: Date.now() 
    });

    return result;
  }

  // 📝 ПОЛУЧЕНИЕ ДЕТАЛЕЙ ПРЕДМЕТА
  async getItemDetails(itemId, currency = 'KZT') {
    const cacheKey = `details_${itemId}_${currency}`;
    
    const memoryCached = this.memoryCache.get(cacheKey);
    if (memoryCached && Date.now() - memoryCached.timestamp < this.cacheDuration) {
      console.log(`[MarketService] ⚡ Детали из кэша: ${itemId}`);
      return memoryCached.item;
    }

    console.log(`[MarketService] 📈 Получение деталей: ${itemId}`);
    
    try {
      const allItems = await this.getMarketItems('cs2', 300, currency, true);
      const item = allItems.find(i => i.id === itemId);
      
      if (!item) {
        throw new Error('Item not found');
      }

      const detailedItem = {
        ...item,
        detailed_info: {
          description: this.generateDescription(item),
          history: this.generatePriceHistory(item),
          similar_items: this.findSimilarItems(item, allItems),
          trade_restrictions: this.getTradeRestrictions(item),
          market_analysis: this.generateMarketAnalysis(item)
        }
      };

      this.memoryCache.set(cacheKey, { 
        item: detailedItem, 
        timestamp: Date.now() 
      });

      return detailedItem;

    } catch (error) {
      console.error('[MarketService] 💥 Ошибка получения деталей:', error);
      throw error;
    }
  }

  // 🏆 ПРЕМИУМ ПРЕДМЕТЫ
  async getPremiumItems(game = 'cs2', currency = 'KZT', limit = 12, silent = false) {
    const cacheKey = `premium_${game}_${currency}`;
    
    const memoryCached = this.memoryCache.get(cacheKey);
    if (memoryCached && Date.now() - memoryCached.timestamp < this.cacheDuration) {
      !silent && console.log(`[MarketService] ⚡ Премиум из памяти: ${memoryCached.items.length} предметов`);
      return memoryCached.items.slice(0, limit);
    }

    const allItems = await this.getMarketItems(game, 200, currency, silent);
    const premiumItems = allItems
      .filter(item => item.rarity === 'Covert' || item.rarity === 'Arcana')
      .sort((a, b) => b.price - a.price)
      .slice(0, limit);

    this.memoryCache.set(cacheKey, { 
      items: premiumItems, 
      timestamp: Date.now() 
    });

    return premiumItems;
  }

  // 🎲 СЛУЧАЙНЫЕ ПРЕДМЕТЫ
  async getRandomItems(limit = 12, currency = 'KZT') {
    const cacheKey = `random_${currency}`;
    
    const memoryCached = this.memoryCache.get(cacheKey);
    if (memoryCached && Date.now() - memoryCached.timestamp < 10 * 60 * 1000) {
      console.log(`[MarketService] ⚡ Случайные из кэша: ${memoryCached.items.length} предметов`);
      return memoryCached.items.slice(0, limit);
    }

    const allItems = await this.getMarketItems('cs2', 100, currency, true);
    const shuffled = [...allItems].sort(() => 0.5 - Math.random());
    const randomItems = shuffled.slice(0, limit);

    this.memoryCache.set(cacheKey, { 
      items: randomItems, 
      timestamp: Date.now() 
    });

    return randomItems;
  }

  // 🏠 ПРЕДМЕТЫ ДЛЯ ГЛАВНОЙ
  async getTopItemsForHome(currency = 'KZT', limit = 8) {
    const cacheKey = `top_home_${currency}`;
    
    const memoryCached = this.memoryCache.get(cacheKey);
    if (memoryCached && Date.now() - memoryCached.timestamp < 5 * 60 * 1000) {
      console.log(`[MarketService] ⚡ Топы для главной из кэша: ${memoryCached.items.length} предметов`);
      return memoryCached.items.slice(0, limit);
    }

    try {
      const popularItems = await this.getPopularItems('cs2', currency, limit, true);
      this.memoryCache.set(cacheKey, { 
        items: popularItems, 
        timestamp: Date.now() 
      });
      return popularItems;
    } catch (error) {
      console.error('[MarketService] 💥 Ошибка получения топов:', error);
      const allItems = await this.getMarketItems('cs2', 20, currency, true);
      return allItems.slice(0, limit);
    }
  }

  // 💰 КОНВЕРТАЦИЯ ВАЛЮТ
  convertCurrency(amount, fromCurrency, toCurrency) {
    if (fromCurrency === toCurrency) return amount;
    
    const amountUSD = amount / this.currencyRates[fromCurrency];
    return Math.round(amountUSD * this.currencyRates[toCurrency]);
  }

  // 📊 СТАТИСТИКА СЕРВИСА
  async getServiceStats() {
    try {
      return {
        memory_cache_size: this.memoryCache.size,
        cache_duration: this.cacheDuration / 60000 + ' минут',
        last_updated: new Date().toISOString(),
        memory_cache_keys: Array.from(this.memoryCache.keys())
      };
    } catch (error) {
      console.error('[MarketService] ❌ Ошибка получения статистики:', error);
      return { error: 'Service stats unavailable' };
    }
  }

  // 📈 ГЕНЕРАЦИЯ ОПИСАНИЯ
  generateDescription(item) {
    const descriptions = {
      'cs2': [
        `Этот скин ${item.name} имеет состояние ${item.exterior}.`,
        `Популярный предмет среди игроков CS2.`,
        `Отличное соотношение цены и качества.`
      ],
      'dota2': [
        `Экипировка для героя Dota 2.`,
        `Качество: ${item.rarity}.`,
        `Востребованный предмет в сообществе.`
      ]
    };

    const gameDesc = descriptions[item.game] || descriptions.cs2;
    return gameDesc[Math.floor(Math.random() * gameDesc.length)];
  }

  // 📊 ГЕНЕРАЦИЯ ИСТОРИИ ЦЕН
  generatePriceHistory(item) {
    const history = [];
    const basePrice = item.original_price || item.price / 500;
    
    for (let i = 30; i >= 0; i--) {
      const date = new Date();
      date.setDate(date.getDate() - i);
      
      const variation = 0.8 + Math.random() * 0.4;
      history.push({
        date: date.toISOString().split('T')[0],
        price: Math.round(basePrice * variation * 500),
        volume: Math.floor(Math.random() * 50)
      });
    }
    
    return history;
  }

  // 🔍 ПОИСК ПОХОЖИХ ПРЕДМЕТОВ
  findSimilarItems(targetItem, allItems) {
    return allItems
      .filter(item => 
        item.id !== targetItem.id && 
        item.rarity === targetItem.rarity &&
        item.game === targetItem.game
      )
      .slice(0, 6);
  }

  // 🔒 ПОЛУЧЕНИЕ ОГРАНИЧЕНИЙ ТОРГОВЛИ
  getTradeRestrictions(item) {
    return {
      tradable: item.tradable !== false,
      marketable: item.marketable !== false,
      cooldown: item.tradable ? null : '7 days',
      notes: item.tradable ? 'Готов к немедленной торговле' : 'Предмет имеет ограничения'
    };
  }

  // 📈 АНАЛИЗ РЫНКА
  generateMarketAnalysis(item) {
    return {
      demand: ['Низкий', 'Средний', 'Высокий'][Math.floor(Math.random() * 3)],
      trend: ['Падает', 'Стабильный', 'Растёт'][Math.floor(Math.random() * 3)],
      liquidity: ['Низкая', 'Средняя', 'Высокая'][Math.floor(Math.random() * 3)],
      recommendation: this.getRecommendation(item)
    };
  }

  // 💡 РЕКОМЕНДАЦИЯ
  getRecommendation(item) {
    if (item.price > 100000) return 'Премиум актив - для долгосрочных инвестиций';
    if (item.price > 50000) return 'Хороший актив - стабильная цена';
    if (item.price > 10000) return 'Популярный предмет - быстрая ликвидность';
    return 'Бюджетный вариант - для начинающих';
  }

  // 🩺 ПРОВЕРКА ЗДОРОВЬЯ
  async healthCheck() {
    try {
      const stats = await this.getServiceStats();
      const testItems = await this.getMarketItems('cs2', 5, 'KZT', true);
      
      return {
        status: 'healthy',
        timestamp: new Date().toISOString(),
        items_available: testItems.length > 0,
        cache_working: true,
        memory_cache_size: this.memoryCache.size,
        details: stats
      };
    } catch (error) {
      return {
        status: 'unhealthy',
        timestamp: new Date().toISOString(),
        error: error.message
      };
    }
  }

  // 💾 СОВМЕСТИМОСТЬ С СТАРЫМ КОДОМ
  enrichItems(items, currency) {
    return items.map(item => ({
      ...item,
      display_price: this.formatPrice(item.price, currency),
      display_original_price: item.original_price ? this.formatPrice(item.original_price, 'USD') : null,
      is_available: true,
      is_listed: true,
      discount: this.calculateDiscount(item.price || 0),
      popular: (item.volume || 0) > 30,
      trending: Math.random() > 0.7,
      featured: Math.random() > 0.9,
      tags: this.generateTagsForItem(item.name || '', item.rarity || '', item.category || ''),
      stats: this.generateStatsForItem(item.price || 0),
      image: item.image_url || item.image,
      market_hash_name: item.market_hash_name || item.name,
      quality: item.quality || 'field-tested',
      exterior: item.exterior || 'Field-Tested'
    }));
  }

  // 🔄 ПОЛУЧЕНИЕ ДОСТУПНЫХ ВАЛЮТ
  getAvailableCurrencies() {
    return [
      { code: 'KZT', name: 'Казахстанский тенге', symbol: '₸', default: true },
      { code: 'USD', name: 'Доллар США', symbol: '$', default: false },
      { code: 'EUR', name: 'Евро', symbol: '€', default: false },
      { code: 'RUB', name: 'Российский рубль', symbol: '₽', default: false },
      { code: 'CNY', name: 'Китайский юань', symbol: '¥', default: false }
    ];
  }
}

export const steamMarketService = new SteamMarketService();
