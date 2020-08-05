import random

# Flask:
from flask import Flask, render_template, jsonify, request, g
# using Flask-WTF CSRF protection for AJAX requests
from flask_wtf.csrf import CSRFProtect

# SQL Alchemy:
import sqlalchemy
from sqlalchemy import create_engine, func, inspect
from sqlalchemy import Column, ForeignKey, Integer, String, TIMESTAMP
from sqlalchemy.orm import relationship, scoped_session, sessionmaker
from sqlalchemy.ext.declarative import declarative_base

from whitenoise import WhiteNoise


def force_unityweb_gzip(headers, path, url):
    if path.endswith('.unityweb'):
        headers['Content-Encoding'] = 'gzip'


app = Flask(__name__, static_folder="./", template_folder="./")
csrf = CSRFProtect(app)
app.wsgi_app = WhiteNoise(app.wsgi_app, root='.', mimetypes={'.unityweb': 'application/octet-stream'},
			  add_headers_function=force_unityweb_gzip)


# TODO: deal with actually reading a proper secret key file
app.secret_key = b'<\xf0\xa8\x99\xdb\xe5\xd1\xcd)\xd6\xfc-|z\xc8\xcc'

### SQL Alchemy Definitions
# The engine, db_session, and Base definitions would be in a db.py filter
# https://flask.palletsprojects.com/en/1.1.x/patterns/sqlalchemy/
engine = create_engine('sqlite:///./games.db', convert_unicode=True)
db_session = scoped_session(sessionmaker(autocommit=False,
                                         autoflush=False,
                                         bind=engine))
Base = declarative_base()
Base.query = db_session.query_property()

### SQL Alchemy model

# TODO: Add a 'Player' class, to link to both the game and game scores?

class Game(Base):
    __tablename__ = 'games'
    id = Column(Integer, primary_key=True)
    player_id = Column(String(32), nullable=False)
    name = Column(String(64), nullable=False)
    description = Column(String(256), nullable=False)
    scoring = Column(String(256), nullable=False)
    timestamp = Column(TIMESTAMP(timezone=True),  server_default=func.now())
    games_scored = relationship('GameScore')


class GameScore(Base):
    __tablename__ = 'game_scores'
    id = Column(Integer, primary_key=True)
    game_id = Column(Integer, ForeignKey('games.id'), nullable=False)
    player_id = Column(String(32), nullable=False)
    score = Column(String(32), nullable=False)
    explanation = Column(String(256))
    feedback = Column(String(256))


def filter_dict_to_model(value_dict, model_class):
    valid_keys = [prop.key for prop in inspect(model_class).iterate_properties
        if isinstance(prop, sqlalchemy.orm.ColumnProperty)]
    return {key: value_dict[key] for key in value_dict if key in valid_keys}


def model_to_dict(model_instance):
    return filter_dict_to_model(model_instance.__dict__, model_instance.__class__)


def init_db():
    # import all modules here that might define models so that
    # they will be registered properly on the metadata.  Otherwise
    # you will have to import them first before calling init_db()
    # import yourapplication.models
    Base.metadata.create_all(bind=engine)


init_db()


@app.teardown_appcontext
def shutdown_session(exception=None):
    db_session.remove()


@app.route('/')
def home():
    return render_template("index.html"), 200


@app.route('/save_game', methods=['POST'])
def save_game():
    game = Game(**filter_dict_to_model(request.form, Game))
    query = Game.query.filter(Game.player_id == game.player_id)
    if query.count() > 0:
        game.id = query.first().id
        if game not in db_session:
            game = db_session.merge(game)

    else:
        db_session.add(game)

    db_session.commit()

    return jsonify({'id': game.id, 'player_id': game.player_id})


@app.route('/save_game_score', methods=['POST'])
def save_game_score():
    game_score = GameScore(**filter_dict_to_model(request.form, GameScore))
    db_session.add(game_score)
    db_session.commit()

    return jsonify(dict(id=game_score.id, player_id=game_score.player_id,
        game_id=game_score.game_id))


@app.route('/find_game_to_play/<player_id>', methods=['GET'])
def find_game_to_play(player_id):
    games_not_created_query = Game.query.filter(Game.player_id != player_id)
    games_not_played_query = games_not_created_query.filter(~Game.games_scored.any(GameScore.player_id == player_id))
    results = games_not_played_query.all()
    if len(results) > 0:
        game = random.choice(results)
        return jsonify(dict(status=True, game=model_to_dict(game)))

    return jsonify(dict(status=False))


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(debug=True, host='0.0.0.0', port = port)
