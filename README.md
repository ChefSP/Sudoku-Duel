# Sudoku Duel

Ranked 1v1: ten sam sudoku dla obu graczy, wygrywa ten, kto pierwszy wypełni całą planszę.

- ranking Elo osobno dla poziomów: Łatwy / Średni / Trudny,
- konta: nick + hasło albo logowanie Google (gość może założyć konto i zachować ranking),
- trwała baza Postgres (Neon / Supabase); bez bazy działa na pliku `data.json` (tylko do testów),
- powrót do meczu po odświeżeniu strony lub zerwaniu połączenia (30 s),
- blokada 4 s po błędnej cyfrze,
- ochrona przed botami: captcha przy rejestracji, limity (IP, wiadomości, logowania), minimalny odstęp między ruchami, unieważnianie nierealnie szybkich wygranych.

## Pliki

```
package.json       # zależności: express, ws, pg
server.js          # serwer: gra, matchmaking, Elo, konta, baza, anty-boty
public/index.html  # cała strona
```

## Uruchomienie lokalnie

```bash
npm install
npm start      # http://localhost:3000 (otwórz w dwóch kartach/oknach prywatnych)
```

## Zmienne środowiskowe (w Render: Environment)

| Zmienna | Po co | Wymagana? |
|---|---|---|
| `DATABASE_URL` | adres bazy Postgres, żeby konta i ranking przetrwały restarty | tak (na serio), nie na testy |
| `GOOGLE_CLIENT_ID` | włącza przycisk "Zaloguj przez Google" | nie |
| `TURNSTILE_SITE_KEY` + `TURNSTILE_SECRET` | włącza captchę przy zakładaniu konta | nie (zalecane) |

Bez zmiennej dana funkcja jest po prostu wyłączona. Tabela w bazie tworzy się sama.

## 1. Baza danych: Neon (darmowa)

1. Wejdź na https://neon.tech, załóż konto (np. przez GitHub).
2. Utwórz projekt (Create project), region np. Frankfurt.
3. Na stronie projektu kliknij **Connect** i skopiuj **connection string** (zaczyna się od `postgresql://`).
4. W Render: Twój serwis → **Environment** → Add Environment Variable: `DATABASE_URL` = skopiowany adres → Save.

Po restarcie w logach zobaczysz: `Baza: Postgres, użytkowników: 0`.

## 2. Logowanie przez Google (opcjonalnie)

1. https://console.cloud.google.com → utwórz projekt.
2. **APIs & Services → OAuth consent screen**: typ External, wpisz nazwę aplikacji i swój e-mail. Na końcu kliknij **Publish app**, inaczej zalogują się tylko dodani testerzy.
3. **Credentials → Create credentials → OAuth client ID** → Web application.
4. W **Authorized JavaScript origins** dodaj adres swojej gry, np. `https://sudoku-duel-xxxx.onrender.com` (oraz `http://localhost:3000` do testów).
5. Skopiuj **Client ID** i wpisz w Render jako `GOOGLE_CLIENT_ID`.

## 3. Captcha przy rejestracji (opcjonalnie)

1. https://dash.cloudflare.com → **Turnstile** → Add widget.
2. Domena: adres Twojej gry (bez https://), np. `sudoku-duel-xxxx.onrender.com`. Tryb: Managed.
3. Skopiuj **Site Key** → `TURNSTILE_SITE_KEY` oraz **Secret Key** → `TURNSTILE_SECRET` w Render.

## Wdrożenie (Render)

Bez zmian: repo na GitHubie, Web Service, Build `npm install`, Start `npm start`.
Po wgraniu nowych plików na GitHub Render sam zrobi deploy. Zmienne środowiskowe dodajesz w zakładce Environment.

## Ustawienia w `server.js` (góra pliku)

- `DIFFS`: liczba usuniętych pól na poziom (38 / 48 / 55),
- `WRONG_LOCK_MS`: blokada po błędzie (4000),
- `GRACE_MS`: czas na powrót do meczu (30000),
- `MIN_MOVE_MS`, `MIN_MS_PER_CELL`, `FLAGS_HIDE`: progi anty-botowe.

## Ograniczenia anty-botowe (uczciwie)

Serwer sam sprawdza każdą cyfrę, więc nie da się oszukać planszy, ale bot z solverem może grać "po ludzku wolno".
Obecne zabezpieczenia odsiewają proste boty: ruchy szybsze niż 120 ms są ignorowane, wygrana szybsza niż 0,4 s na pole jest unieważniana (bez zmiany Elo), a konto z 3 unieważnieniami znika z rankingu.
Limity po IP są "best effort": za proxy Render adres IP jest brany z nagłówka `X-Forwarded-For`.
Gdyby pojawiło się dużo botów, kolejne kroki to obowiązkowe konto do gry rankingowej i wykrywanie wzorców czasowych.
