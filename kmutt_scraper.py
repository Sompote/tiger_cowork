#!/usr/bin/env python3
"""
KMUTT Web Scraper
Scrapes content from www.kmutt.ac.th (King Mongkut's University of Technology Thonburi)
"""

import requests
from bs4 import BeautifulSoup
import json
import time
from urllib.parse import urljoin, urlparse
import re
from datetime import datetime
import logging

# Configure logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

class KMUTTScraper:
    def __init__(self, base_url='https://www.kmutt.ac.th', language='th'):
        """
        Initialize the scraper
        
        Args:
            base_url: Base URL of KMUTT website
            language: 'th' for Thai, 'en' for English
        """
        self.base_url = base_url
        self.language = language
        self.session = requests.Session()
        self.session.headers.update({
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
        })
        
        # Adjust URL based on language
        if language == 'en':
            self.base_url = urljoin(base_url, '/en/')
    
    def fetch_page(self, url):
        """Fetch a page with error handling"""
        try:
            response = self.session.get(url, timeout=10)
            response.raise_for_status()
            time.sleep(1)  # Rate limiting
            return response.text
        except requests.exceptions.RequestException as e:
            logger.error(f"Error fetching {url}: {e}")
            return None
    
    def get_soup(self, url):
        """Get BeautifulSoup object from URL"""
        html = self.fetch_page(url)
        if html:
            return BeautifulSoup(html, 'html.parser')
        return None
    
    def scrape_news(self, max_news=20):
        """Scrape latest news and announcements"""
        logger.info(f"Scraping news from {self.base_url}")
        
        soup = self.get_soup(self.base_url)
        if not soup:
            return []
        
        news_items = []
        
        # Try different selectors for news
        news_selectors = [
            'article.post',
            'div.post',
            'section.news',
            '.wp-block-post-template',
            '.recent-news',
            'div[class*="news"]',
            'div[class*="announcement"]'
        ]
        
        for selector in news_selectors:
            elements = soup.select(selector)
            if elements:
                logger.info(f"Found {len(elements)} items with selector: {selector}")
                break
        
        # Extract news items
        for i, element in enumerate(elements[:max_news]):
            try:
                title_elem = element.select_one('h2, h3, h4, .entry-title, a')
                title = title_elem.get_text(strip=True) if title_elem else f"News {i+1}"
                
                link_elem = element.select_one('a')
                link = urljoin(self.base_url, link_elem['href']) if link_elem and link_elem.get('href') else None
                
                date_elem = element.select_one('.date, .posted-on, time, .entry-date')
                date = date_elem.get_text(strip=True) if date_elem else None
                
                excerpt_elem = element.select_one('.excerpt, .summary, p')
                excerpt = excerpt_elem.get_text(strip=True)[:200] if excerpt_elem else None
                
                image_elem = element.select_one('img')
                image = urljoin(self.base_url, image_elem['src']) if image_elem and image_elem.get('src') else None
                
                news_items.append({
                    'title': title,
                    'link': link,
                    'date': date,
                    'excerpt': excerpt,
                    'image': image
                })
            except Exception as e:
                logger.warning(f"Error parsing news item {i}: {e}")
                continue
        
        logger.info(f"Successfully scraped {len(news_items)} news items")
        return news_items
    
    def scrape_faculties(self):
        """Scrape faculty/department information"""
        logger.info("Scraping faculties and departments")
        
        # Common faculty pages
        faculties_urls = [
            urljoin(self.base_url, '/faculties/'),
            urljoin(self.base_url, '/academics/'),
            urljoin(self.base_url, '/about/'),
        ]
        
        faculties = []
        
        for url in faculties_urls:
            soup = self.get_soup(url)
            if not soup:
                continue
            
            # Look for faculty links
            faculty_selectors = [
                'a[href*="faculty"]',
                'a[href*="college"]',
                'a[href*="department"]',
                '.faculty-list a',
                '.departments a'
            ]
            
            for selector in faculty_selectors:
                elements = soup.select(selector)
                if elements:
                    for elem in elements[:20]:  # Limit to 20
                        try:
                            name = elem.get_text(strip=True)
                            link = urljoin(url, elem['href']) if elem.get('href') else None
                            
                            if name and len(name) > 2:
                                faculties.append({
                                    'name': name,
                                    'link': link
                                })
                        except Exception as e:
                            continue
                    break
        
        # Remove duplicates
        seen = set()
        unique_faculties = []
        for faculty in faculties:
            if faculty['name'] not in seen:
                seen.add(faculty['name'])
                unique_faculties.append(faculty)
        
        logger.info(f"Found {len(unique_faculties)} faculties/departments")
        return unique_faculties
    
    def scrape_contact_info(self):
        """Scrape contact information"""
        logger.info("Scraping contact information")
        
        contact_urls = [
            urljoin(self.base_url, '/contact/'),
            urljoin(self.base_url, '/about/'),
            urljoin(self.base_url, '/'),
        ]
        
        contact_info = {}
        
        for url in contact_urls:
            soup = self.get_soup(url)
            if not soup:
                continue
            
            # Look for contact information
            contact_patterns = {
                'phone': r'\+?\d{1,4}[-.\s]?\(?\d{1,4}\)?[-.\s]?\d{1,4}[-.\s]?\d{4}',
                'email': r'[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}',
                'address': r'(\d+\s+\w+\s+(?:Street|Road|Rd|St|Avenue|Ave|Lane|Ln|Boulevard|Blvd|Soi| alley| alley))',
            }
            
            text = soup.get_text()
            
            for key, pattern in contact_patterns.items():
                matches = re.findall(pattern, text)
                if matches:
                    contact_info[key] = list(set(matches))[:5]  # Limit to 5 unique matches
        
        # Also try to find specific contact sections
        contact_selectors = [
            '.contact-info',
            '.contact',
            '#contact',
            'footer',
            '.footer'
        ]
        
        for selector in contact_selectors:
            elements = soup.select(selector)
            if elements:
                contact_text = elements[0].get_text()
                for key in ['phone', 'email']:
                    if key not in contact_info:
                        matches = re.findall(contact_patterns[key], contact_text)
                        if matches:
                            contact_info[key] = list(set(matches))[:5]
        
        logger.info(f"Found contact info: {contact_info}")
        return contact_info
    
    def scrape_menu_structure(self):
        """Scrape website menu structure"""
        logger.info("Scraping menu structure")
        
        soup = self.get_soup(self.base_url)
        if not soup:
            return []
        
        menu_items = []
        
        # Look for navigation menus
        menu_selectors = [
            '.main-navigation',
            '.navigation',
            'nav',
            '.menu',
            '.mega-menu',
            '.wp-block-navigation'
        ]
        
        for selector in menu_selectors:
            menus = soup.select(selector)
            if menus:
                for menu in menus[:3]:  # Check first 3 menus
                    links = menu.select('a')
                    for link in links[:50]:  # Limit to 50 items
                        try:
                            text = link.get_text(strip=True)
                            href = link.get('href')
                            
                            if text and href:
                                full_url = urljoin(self.base_url, href)
                                menu_items.append({
                                    'text': text,
                                    'url': full_url
                                })
                        except Exception as e:
                            continue
                break
        
        # Remove duplicates
        seen = set()
        unique_menu = []
        for item in menu_items:
            key = (item['text'], item['url'])
            if key not in seen:
                seen.add(key)
                unique_menu.append(item)
        
        logger.info(f"Found {len(unique_menu)} menu items")
        return unique_menu
    
    def scrape_all(self, output_file='kmutt_data.json'):
        """Scrape all available information and save to file"""
        logger.info("Starting comprehensive scrape of KMUTT website")
        
        data = {
            'scrape_date': datetime.now().isoformat(),
            'base_url': self.base_url,
            'language': self.language,
            'news': self.scrape_news(),
            'faculties': self.scrape_faculties(),
            'contact_info': self.scrape_contact_info(),
            'menu_structure': self.scrape_menu_structure()
        }
        
        # Save to JSON file
        with open(output_file, 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        
        logger.info(f"Data saved to {output_file}")
        return data


def main():
    """Main function to run the scraper"""
    print("=" * 60)
    print("KMUTT Web Scraper")
    print("Scraping King Mongkut's University of Technology Thonburi")
    print("=" * 60)
    
    # Create scraper instance (Thai version)
    scraper_th = KMUTTScraper(language='th')
    
    # Scrape all data
    data_th = scraper_th.scrape_all('kmutt_thai.json')
    
    print(f"\nScraped {len(data_th['news'])} news items")
    print(f"Found {len(data_th['faculties'])} faculties/departments")
    print(f"Menu items: {len(data_th['menu_structure'])}")
    print(f"Contact info found: {bool(data_th['contact_info'])}")
    
    # Also scrape English version
    print("\n" + "=" * 60)
    print("Scraping English version...")
    print("=" * 60)
    
    scraper_en = KMUTTScraper(language='en')
    data_en = scraper_en.scrape_all('kmutt_english.json')
    
    print(f"\nScraped {len(data_en['news'])} news items")
    print(f"Found {len(data_en['faculties'])} faculties/departments")
    
    # Display sample news
    print("\n" + "=" * 60)
    print("Sample News Items (Thai):")
    print("=" * 60)
    for i, news in enumerate(data_th['news'][:5], 1):
        print(f"{i}. {news['title']}")
        if news['date']:
            print(f"   Date: {news['date']}")
        if news['link']:
            print(f"   Link: {news['link']}")
        print()
    
    print("\nScraping complete! Files saved:")
    print("- kmutt_thai.json")
    print("- kmutt_english.json")


if __name__ == "__main__":
    main()
