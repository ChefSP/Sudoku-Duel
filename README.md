# Sudoku Duel

Ranked 1v1: ten sam sudoku dla obu graczy, wygrywa ten, kto pierwszy wypełni całą planszę.

## Funkcje

- **Poziomy:** Łatwy (blokada 2 s po błędzie), Średni (4 s), Trudny (10 s) oraz **Hardcore** (plansza z trudnego, bez blokady i bez sprawdzania cyfr: błąd zostaje na planszy, wygrywa pierwszy z całą poprawną planszą).
- **Gra rankingowa** (tylko konta, Elo osobno na każdym poziomie) i **towarzyska** (każdy, bez rankingu).
- **Goście:** nick `Guest1234`, bez rankingu i bez historii. Nicki są unikalne, a `Guest…` jest zarezerwowany dla gości.
- **Solo**, **notatki w komórkach** (podwójne kliknięcie pustego pola, przycisk ✎ albo klawisz N), **rewanż** jednym kliknięciem, **pojedynek ze znajomym przez link** (bez rankingu).
- **Statystyki** (średni i najlepszy czas, passa wygranych, skuteczność), **wykres Elo** i **historia meczów** (ostatnie 50): ekran "Moje statystyki" w menu po zalogowaniu.
- **Zgłaszanie graczy** (🚩 w trakcie meczu i na ekranie wyniku), **panel admina z banami** (konto albo IP).
- Konta: nick + hasło albo Google, trwała baza Postgres, powrót do meczu po odświeżeniu strony (30 s), ochrona przed botami.

Statystyki, passa i wykres liczą **tylko mecze rankingowe**. Czasy: tylko z rozwiązanych plansz (nie z poddania ani rozłączenia). Historia zawiera wszystkie mecze konta (też towarzyskie i ze znajomym, z oznaczeniem trybu).

## Pliki

```
package.json
server.js            # gra, matchmaking, Elo, konta, baza, statystyki, zgłoszenia, bany
public/index.html    # gra
public/admin.html    # panel admina (/admin.html)
```

## Zmienne środowiskowe (Render → Environment)

| Zmienna | Po co | Wymagana? |
|---|---|---|
| `DATABASE_URL` | adres Postgres (Neon), żeby dane przetrwały restarty | tak (na serio) |
| `ADMIN_PASSWORD` | hasło do panelu `/admin.html`. Bez niego panel jest wyłączony | zalecane |
| `GOOGLE_CLIENT_ID` | przycisk "Zaloguj przez Google" | nie |
| `TURNSTILE_SITE_KEY` + `TURNSTILE_SECRET` | captcha przy zakładaniu konta | nie (zalecane) |

Tabele (`users`, `reports`, `bans`) tworzą się same. Konfiguracja Neon, Google i Turnstile: bez zmian względem poprzedniej wersji (Neon: neon.tech → Connect → connection string → `DATABASE_URL`).

## Panel admina

1. W Render dodaj `ADMIN_PASSWORD` (długie, losowe hasło) i poczekaj na restart.
2. Wejdź na `https://twoja-gra.onrender.com/admin.html` i wpisz to hasło.
3. Widzisz zgłoszenia pogrupowane po graczu (liczba zgłoszeń, powody, opisy, IP, ile meczów unieważnił system anty-botowy). Do wyboru:
   - **Zablokuj konto**: gracz jest od razu rozłączony, nie zaloguje się, znika z rankingu. Mecz, który właśnie grał, zostaje unieważniony dla przeciwnika.
   - **Zablokuj IP (7 dni)**: dla gości i osób, które zakładają nowe konta. Uwaga: pod jednym IP może siedzieć wiele osób (szkoła, sieć komórkowa), więc używaj oszczędnie.
   - **Odrzuć zgłoszenia**.
4. Sekcja "Sprawdź gracza" pokazuje dane po nicku i pozwala zablokować go ręcznie. Lista blokad ma przycisk **Odblokuj**.

Zgłoszenia starsze niż 60 dni (odrzucone: 7 dni) i wygasłe blokady IP kasują się same. Adresy IP są przechowywane tylko w zgłoszeniach i blokadach.

## Uruchomienie lokalnie

```bash
npm install
npm start      # http://localhost:3000
```

## Ustawienia w `server.js` (góra pliku)

`DIFFS` (liczba pustych pól i długość blokady), `GRACE_MS` (czas na powrót do meczu), `HISTORY_MAX` i `ELO_LOG_MAX` (ile historii pamiętamy), progi anty-botowe `MIN_MOVE_MS`, `MIN_MS_PER_CELL`, `FLAGS_HIDE`.

## Ograniczenia anty-botowe (uczciwie)

Serwer sam sprawdza każdą cyfrę, ale bot z solverem może grać "po ludzku wolno". Odsiewamy proste boty: ruchy częstsze niż co 120 ms są ignorowane, wygrana szybsza niż 0,4 s na pole jest unieważniana (bez zmiany Elo), a konto z 3 unieważnieniami znika z rankingu. Resztą zajmują się zgłoszenia graczy i panel admina. Limity po IP są "best effort" (adres IP jest brany z nagłówka `X-Forwarded-For`).
