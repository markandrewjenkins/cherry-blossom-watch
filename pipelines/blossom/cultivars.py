"""Cultivar catalogue: identity, bloom-group, flower attributes and an editorial tier.

Tiers rank how sought-after each cultivar is for blossom viewing: flower size and form,
colour, rarity on local streets, and how much of a crowd it draws at festivals.
They are an editorial judgement, stated as such on the site.
"""
from __future__ import annotations

# key: (display name, bloom group, tier, colour, form, habit, one-line note, Commons search)
CULTIVARS = {
    "akebono":        ("Akebono", "yoshino", "S", "Soft blush pink", "Single", "Spreading vase",
                       "Vancouver's signature street cherry: a cloud of pale pink at Burrard Station every spring.", "Prunus Akebono cherry blossom"),
    "yoshino":        ("Somei-yoshino", "yoshino", "S", "White with a pink blush", "Single", "Spreading",
                       "Japan's classic hanami cherry, the one on the national bloom forecasts.", "Prunus yedoensis Somei-yoshino blossom"),
    "kanzan":         ("Kanzan", "japanese", "S", "Deep pink", "Double (20–30 petals)", "Upright vase",
                       "The pom-pom pink tunnels of late April, and the most-planted street cherry in Vancouver.", "Prunus Kanzan cherry blossom"),
    "shirotae":       ("Shirotae (Mount Fuji)", "yoshino", "S", "Pure white", "Semi-double, fragrant", "Wide, flat-topped",
                       "Large snowy blossoms on horizontal branches. A festival favourite.", "Prunus Shirotae cherry blossom"),
    "ukon":           ("Ukon", "japanese", "S", "Pale yellow-green", "Semi-double", "Spreading",
                       "The rare 'green' cherry. Spot one and you've found a prize.", "Prunus Ukon cherry blossom"),
    "taihaku":        ("Tai Haku (Great White)", "japanese", "A", "Brilliant white", "Single, very large", "Spreading",
                       "Saucer-sized white flowers against copper new leaves.", "Prunus Tai Haku cherry blossom"),
    "shirofugen":     ("Shirofugen", "japanese", "A", "Pink buds opening white", "Double", "Wide spreading",
                       "One of the last to bloom. Flowers fade from pink to white and back to pink.", "Prunus Shirofugen cherry blossom"),
    "amanogawa":      ("Amanogawa", "japanese", "A", "Shell pink", "Semi-double, fragrant", "Columnar",
                       "A narrow 'Milky Way' column of blossom, very photogenic.", "Prunus Amanogawa cherry"),
    "weeping":        ("Weeping cherry", "early", "A", "Pale pink", "Single", "Weeping",
                       "Cascading curtains of blossom.", "Prunus subhirtella Pendula weeping cherry blossom"),
    "accolade":       ("Accolade", "early", "A", "Rich pink", "Semi-double", "Spreading",
                       "Early, generous and very pink: often the first 'real' cherry of spring.", "Prunus Accolade blossom"),
    "pinkperfection": ("Pink Perfection", "japanese", "B", "Bright pink", "Double", "Upright vase",
                       "Like a softer, later Kanzan.", "Prunus Pink Perfection cherry"),
    "snowgoose":      ("Snow Goose", "yoshino", "B", "White", "Single", "Upright",
                       "Clean white flowers held with fresh green leaves. Common in Victoria.", "Prunus Snow Goose cherry"),
    "umineko":        ("Umineko", "early", "B", "White", "Single", "Narrow upright",
                       "The 'seagull' cherry: crisp white and tidy.", "Prunus Umineko cherry"),
    "whitcomb":       ("Whitcomb", "early", "B", "Light pink", "Semi-double", "Wide spreading",
                       "A very early pink, sometimes flowering in February.", "Prunus subhirtella Whitcomb"),
    "higan":          ("Higan / Autumn cherry", "early", "B", "Pale pink", "Semi-double", "Spreading",
                       "Flowers on and off from late autumn through early spring.", "Prunus subhirtella Autumnalis flowers"),
    "sargent":        ("Sargent cherry", "early", "B", "Rose pink", "Single", "Vase / columnar",
                       "Early, deep pink single flowers and great autumn colour.", "Prunus sargentii flowers"),
    "royalburgundy":  ("Royal Burgundy", "japanese", "B", "Deep pink", "Double", "Upright",
                       "Kanzan-style blossom over purple leaves.", "Prunus Royal Burgundy cherry"),
    "jpcherry":       ("Japanese flowering cherry", "japanese", "B", "Pink or white", "Varies", "Varies",
                       "Unnamed Japanese cherry: cultivar not recorded.", "Prunus serrulata flowers"),
    "blireana":       ("Blireana plum", "plum", "B", "Rose pink", "Double", "Rounded",
                       "The prettiest of the plums: double pink flowers with a hint of scent.", "Prunus blireiana flowers"),
    "purpleplum":     ("Purple-leaf plum", "plum", "C", "Pale pink", "Single", "Rounded",
                       "The first wave of spring in late February and March: small pink flowers over wine-red leaves.", "Prunus cerasifera Nigra flowers"),
    "cherryplum":     ("Cherry plum", "plum", "C", "White", "Single", "Rounded",
                       "White froth in early spring, often before the leaves.", "Prunus cerasifera flowers white"),
    "hillier":        ("Hillier Spire", "early", "C", "Soft pink", "Single", "Columnar",
                       "A narrow early cherry for tight boulevards.", "Prunus Spire cherry"),
    "apricot":        ("Japanese apricot", "plum", "B", "White to pink, fragrant", "Single", "Rounded",
                       "Ume: fragrant winter flowers, often the earliest of all.", "Prunus mume flowers"),
    "wildcherry":     ("Wild / sweet cherry", "wild", "D", "White", "Single", "Tall, upright",
                       "Fruiting cherry with modest white flowers. Birds love it.", "Prunus avium flowers"),
    "bittercherry":   ("Bitter cherry (native)", "bitter", "D", "White", "Single, small", "Upright",
                       "BC's native cherry: small white clusters in late spring.", "Prunus emarginata flowers"),
    "chokecherry":    ("Chokecherry", "wild", "D", "White", "Bottlebrush clusters", "Upright",
                       "Bottlebrush spikes of tiny white flowers. 'Schubert' has purple leaves.", "Prunus virginiana flowers"),
    "birdcherry":     ("Bird cherry", "wild", "D", "White, fragrant", "Bottlebrush clusters", "Spreading",
                       "Fragrant white spikes.", "Prunus padus flowers"),
    "fruitcherry":    ("Fruiting cherry", "wild", "D", "White", "Single", "Rounded",
                       "Sour, black and pin cherries: grown for fruit or habitat more than spectacle.", "Prunus cerasus flowers"),
    "plum":           ("Fruiting plum", "plum", "D", "White", "Single", "Rounded",
                       "Orchard plum with plain white flowers.", "Prunus domestica flowers"),
    "paperbark":      ("Paperbark cherry", "wild", "D", "White, small", "Single", "Rounded",
                       "Grown for its gleaming mahogany bark; the flowers hide under the leaves.", "Prunus serrula bark"),
    "manchurian":     ("Manchurian cherry", "wild", "D", "White", "Clusters", "Upright",
                       "Hardy tree with honey-coloured bark and small white flowers.", "Prunus maackii"),
    "cherry":         ("Cherry (species unrecorded)", "japanese", "C", "Pink or white", "Varies", "Varies",
                       "The inventory doesn't record which cherry this is.", "cherry blossom street"),
}

TIER_BLURB = {
    "S": "Worth a special trip",
    "A": "Stop the car",
    "B": "Lovely when you pass one",
    "C": "Pretty in a crowd",
    "D": "Blink and you'll miss it",
}


def cultivar_key(botanical: str, common: str) -> str | None:
    s = f"{botanical or ''} {common or ''}".lower()
    if "laurel" in s or "laurocerasus" in s or "lusitanica" in s:
        return None
    rules = [
        ("akebono", ["akebono"]), ("shirotae", ["shirotae", "mt fuji", "mount fuji"]), ("ukon", ["ukon"]),
        ("taihaku", ["tai haku", "taihaku", "great white"]), ("shirofugen", ["shirofugen"]),
        ("amanogawa", ["amanogawa"]), ("pinkperfection", ["pink perfection"]), ("snowgoose", ["snow goose"]),
        ("umineko", ["umineko"]), ("whitcomb", ["whitcomb"]), ("royalburgundy", ["royal burg"]),
        ("accolade", ["accolade"]), ("hillier", ["hillier", "spire"]),
        ("kanzan", ["kwanzan", "kanzan"]), ("weeping", ["weeping", "pendula", "snow fountains", "cheals"]),
        ("higan", ["higan", "subhirtella", "autumnalis"]), ("sargent", ["sargent"]),
        ("yoshino", ["yedoensis", "yoshino"]), ("blireana", ["blireana", "blieriana", "blireiana"]),
        ("apricot", ["mume", "apricot", "simonii"]),
        ("purpleplum", ["nigra", "pissard", "atropurpurea", "purple leaf", "purple haze", "thundercloud", "newport", "night purple", "purple plum", "linsay", "lindsay"]),
        ("cherryplum", ["cerasifera", "ceresifera", "cherry plum", "cherry, plum or peach"]),
        ("plum", ["domestica", "common plum"]),
        ("bittercherry", ["emarginata", "bitter cherry"]), ("chokecherry", ["virginiana", "chokecherry"]),
        ("birdcherry", ["padus", "birdcherry", "bird cherry"]), ("paperbark", ["serrula ", "paperbark", "birch bark", "tibetan"]),
        ("manchurian", ["maackii", "manchurian"]),
        ("wildcherry", ["avium", "mazzard", "wild cherry", "sweet cherry", "sweetheart"]),
        ("fruitcherry", ["cerasus", "sour cherry", "serotina", "black cherry", "pensylvanica", "pennsylvanica", "pin cherry"]),
        ("jpcherry", ["serrulata", "japanese", "flowering cherry", "seiboldi", "wada", "umineko"]),
    ]
    for key, words in rules:
        if any(w in s for w in words):
            return key
    if "prunus" in s or "cherry" in s:
        return "cherry"
    return None
