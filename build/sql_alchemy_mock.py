import sqlalchemy
from sqlalchemy import create_engine, func, inspect
from sqlalchemy import Column, ForeignKey, Integer, String, TIMESTAMP
from sqlalchemy.orm import relationship, scoped_session, sessionmaker
from sqlalchemy.ext.declarative import declarative_base

engine = create_engine('sqlite:///./mock_test.db', convert_unicode=True)
db_session = scoped_session(sessionmaker(autocommit=False,
                                         autoflush=False,
                                         bind=engine))
Base = declarative_base()
Base.query = db_session.query_property()


### SQL Aclhemy model
class Game(Base):
    __tablename__ = 'games'
    id = Column(Integer, primary_key=True)
    player_id = Column(String(32), nullable=False)
    name = Column(String(64), nullable=False)
    games_scored = relationship('GameScore')

    def __repr__(self):
        return f'{self.id} | {self.player_id} | {self.name}'


class GameScore(Base):
    __tablename__ = 'game_scores'
    id = Column(Integer, primary_key=True)
    game_id = Column(Integer, ForeignKey('games.id'), nullable=False)
    player_id = Column(String(32), nullable=False)
    score = Column(String(32), nullable=False)

    def __repr__(self):
        return f'{self.id} | {self.game_id} | {self.player_id} | {self.score}'

def init_db():
    # import all modules here that might define models so that
    # they will be registered properly on the metadata.  Otherwise
    # you will have to import them first before calling init_db()
    # import yourapplication.models
    Base.metadata.create_all(bind=engine)


init_db()

def add_from_dict(model_class, values):
    db_session.add(model_class(**values))

def add_data():
    games = [
        dict(player_id='a', name='A Game'),
        dict(player_id='a', name='A Second Game'),
        dict(player_id='b', name='B Game'),
        dict(player_id='c', name='C Game'),
    ]

    game_scores = [
        dict(game_id=1, player_id='a', score='1'),
        dict(game_id=2, player_id='a', score='1'),
        dict(game_id=3, player_id='b', score='2'),
        dict(game_id=4, player_id='c', score='3'),
        dict(game_id=2, player_id='b', score='2'),
    ]

    [add_from_dict(Game, values) for values in games]
    db_session.commit()
    [add_from_dict(GameScore, values) for values in game_scores]
    db_session.commit()
