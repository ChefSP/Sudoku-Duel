# Sudoku Duel

Ranked 1v1: ten sam sudoku dla obu graczy, wygrywa ten, kto pierwszy wypełni całą planszę.
Ranking Elo, matchmaking po rankingu, pasek postępu przeciwnika, kara 5 s za błędną cyfrę.

## Struktura

```
sudoku-duel/
├── package.json
├── server.js          # serwer: WebSocket, matchmaking, Elo, walidacja ruchów
└── public/
    └── index.html     # cała strona (menu, plansza, ranking)
```

## Uruchomienie lokalnie

```bash
npm install
npm start
# otwórz http://localhost:3000 w DWÓCH kartach (albo dwóch przeglądarkach) i kliknij "Szukaj przeciwnika"
```

## Dostępne wszędzie: hosting

Serwer musi działać cały czas (trzyma połączenia WebSocket), więc potrzebujesz hostingu na Node.js.
Statyczne hostingi typu GitHub Pages / Netlify / Vercel NIE wystarczą.

### Opcja A: za darmo (Render) - na start

1. Wrzuć folder na GitHub (nowe repo, `git init`, `git add .`, `git commit`, `git push`).
2. Wejdź na https://render.com, zaloguj się przez GitHub.
3. New → Web Service → wybierz repo.
4. Runtime: Node, Build Command: `npm install`, Start Command: `npm start`, Instance Type: Free.
5. Po deployu dostajesz adres `https://twoja-nazwa.onrender.com`. HTTPS i WebSockety działają od razu.

Wady darmowego planu (sprawdź aktualne limity na stronie Render):
- po okresie bez ruchu serwis "zasypia", pierwsze wejście trwa kilkadziesiąt sekund,
- dysk jest tymczasowy: `data.json` (konta i ranking) kasuje się przy restarcie/deployu.
  Na testy z kolegami OK, na prawdziwy ranking już nie.

### Opcja B: tanio (ok. 20-25 zł/mies.) - gdy ma działać na serio

Mały VPS (np. Hetzner CX22, ok. 4-5 €/mies.) - serwer działa 24/7, dysk jest trwały, ranking nie ginie.

```bash
# na świeżym Ubuntu 24.04, jako root
apt update && apt install -y nodejs npm git caddy
git clone https://github.com/TWOJ_LOGIN/sudoku-duel.git /opt/sudoku-duel
cd /opt/sudoku-duel && npm install
npm install -g pm2
PORT=3000 pm2 start server.js --name sudoku
pm2 save && pm2 startup
```

Plik `/etc/caddy/Caddyfile` (Caddy sam załatwia darmowy certyfikat HTTPS i obsługuje WebSockety):

```
twojadomena.pl {
    reverse_proxy localhost:3000
}
```

`systemctl reload caddy` i gotowe.

### Domena (opcjonalnie)

Adres `.onrender.com` działa, ale własna domena to ok. 40-60 zł/rok (np. .pl, .com).
W panelu rejestratora ustaw rekord A na IP serwera (VPS) albo CNAME na adres Render (w Render: Settings → Custom Domains).

## Co dalej (pomysły)

- trwała baza (SQLite / Supabase / Turso) zamiast `data.json`,
- konta z hasłem lub logowanie Google (teraz konto = token w przeglądarce, wyczyszczenie danych = nowe konto),
- poziomy trudności i osobne rankingi,
- ponowne połączenie po odświeżeniu strony w trakcie meczu (teraz rozłączenie = przegrana),
- ochrona przed botami (limit ruchów, captcha przy rejestracji).
