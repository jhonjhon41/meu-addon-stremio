const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const axios = require('axios');
const cheerio = require('cheerio');

// ==========================================
// CONFIGURAÇÃO DE CHAVES DE API
// ==========================================
const TMDB_API_KEY = '4be18d42cca70cd7ec0a0d05abc9862e';
const ALLDEBRID_API_KEY = 'CbTfhkViITWW0jUv4KX0umBI';
const AGENT_NAME = 'meuaddon';

// ==========================================
// 1. TRADUZIR O ID DO STREMIO PARA O TÍTULO BR
// ==========================================
async function obterTituloEmPortugues(imdbId, type) {
    try {
        const url = 'https://api.themoviedb.org/3/find/' + imdbId + '?api_key=' + TMDB_API_KEY + '&external_source=imdb_id&language=pt-BR';
        const res = await axios.get(url);

        if (type === 'movie' && res.data.movie_results && res.data.movie_results.length > 0) {
            const filme = res.data.movie_results[0];
            return {
                titulo: filme.title,
                ano: filme.release_date ? filme.release_date.split('-')[0] : ''
            };
        } else if (type === 'series' && res.data.tv_results && res.data.tv_results.length > 0) {
            const serie = res.data.tv_results[0];
            return {
                titulo: serie.name,
                ano: serie.first_air_date ? serie.first_air_date.split('-')[0] : ''
            };
        }
    } catch (e) {
        console.error('Erro ao buscar título no TMDB:', e.message);
    }
    return null;
}

// ==========================================
// 2. BUSCAR FONTES DUBLADAS (SCRAPER DE TORRENT BR)
// ==========================================
async function buscarFontesDubladas(titulo, ano) {
    const resultados = [];
    try {
        const termoBusca = encodeURIComponent(titulo + ' ' + ano + ' Dublado');
        const buscaUrl = 'https://comandotorrents.vet/?s=' + termoBusca;
        
        const buscaRes = await axios.get(buscaUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
            timeout: 8000
        });

        const $ = cheerio.load(buscaRes.data);
        const primeiroPostUrl = $('div.post h2 a').first().attr('href');

        if (primeiroPostUrl) {
            const postRes = await axios.get(primeiroPostUrl, {
                headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
                timeout: 8000
            });
            const $post = cheerio.load(postRes.data);

            $post('a[href^="magnet:"]').each((i, el) => {
                const magnet = $post(el).attr('href');
                const textoBotao = $post(el).text().trim() || $post(el).parent().text().trim();

                const isDublado = /dublado|dual/i.test(textoBotao) || /dublado|dual/i.test(magnet);

                if (isDublado && magnet) {
                    let qualidade = '1080p';
                    if (/4k|2160p/i.test(textoBotao)) qualidade = '4K';
                    else if (/720p/i.test(textoBotao)) qualidade = '720p';

                    resultados.push({
                        qualidade: qualidade,
                        magnet: magnet
                    });
                }
            });
        }
    } catch (e) {
        console.error('Erro ao raspar fontes dubladas:', e.message);
    }
    return resultados;
}

// ==========================================
// 3. RESOLVER O MAGNET NO ALLDEBRID
// ==========================================
async function resolverComAllDebrid(magnet) {
    try {
        const uploadUrl = 'https://api.alldebrid.com/v4/magnet/upload?agent=' + AGENT_NAME + '&apikey=' + ALLDEBRID_API_KEY;
        const formData = new URLSearchParams();
        formData.append('magnets[]', magnet);

        const uploadRes = await axios.post(uploadUrl, formData);
        const magnetData = uploadRes.data && uploadRes.data.data && uploadRes.data.data.magnets ? uploadRes.data.data.magnets[0] : null;

        if (!magnetData || !magnetData.id) return null;

        let linkDiretoOriginal = null;

        if (magnetData.ready && magnetData.links && magnetData.links.length > 0) {
            linkDiretoOriginal = magnetData.links[0].link;
        } else {
            const statusUrl = 'https://api.alldebrid.com/v4/magnet/status?agent=' + AGENT_NAME + '&apikey=' + ALLDEBRID_API_KEY + '&id=' + magnetData.id;
            const statusRes = await axios.get(statusUrl);
            const statusData = statusRes.data && statusRes.data.data ? statusRes.data.data.magnets : null;

            if (statusData && statusData.status === 'Ready' && statusData.links && statusData.links.length > 0) {
                linkDiretoOriginal = statusData.links[0].link;
            }
        }

        if (!linkDiretoOriginal) return null;

        const unlockUrl = 'https://api.alldebrid.com/v4/link/unlock?agent=' + AGENT_NAME + '&apikey=' + ALLDEBRID_API_KEY + '&link=' + encodeURIComponent(linkDiretoOriginal);
        const unlockRes = await axios.get(unlockUrl);

        return (unlockRes.data && unlockRes.data.data && unlockRes.data.data.link) ? unlockRes.data.data.link : null;
    } catch (e) {
        console.error('Falha ao resolver via AllDebrid:', e.response && e.response.data ? e.response.data : e.message);
        return null;
    }
}

// ==========================================
// 4. CONFIGURAÇÃO DO ADDON STREMIO
// ==========================================
const manifest = {
    id: 'org.meuaddon.dublados.alldebrid',
    version: '1.0.0',
    name: 'Dublados BR (AllDebrid)',
    description: 'Fontes Dubladas via AllDebrid',
    types: ['movie', 'series'],
    resources: ['stream'],
    catalogs: []
};

const builder = new addonBuilder(manifest);

builder.defineStreamHandler(async ({ type, id }) => {
    const imdbId = id.split(':')[0];

    const dadosMidia = await obterTituloEmPortugues(imdbId, type);
    if (!dadosMidia) return { streams: [] };

    const fontes = await buscarFontesDubladas(dadosMidia.titulo, dadosMidia.ano);
    const streams = [];

    for (const fonte of fontes) {
        const streamUrl = await resolverComAllDebrid(fonte.magnet);
        if (streamUrl) {
            streams.push({
                name: 'AllDebrid [' + fonte.qualidade + ']',
                title: '🇧🇷 ' + dadosMidia.titulo + '\nÁudio: Dublado',
                url: streamUrl
            });
        }
    }

    return { streams };
});

const port = process.env.PORT || 7000;
serveHTTP(builder.getInterface(), { port: port });
console.log('Addon em execução na porta ' + port);
